import {
  Factories,
  bytesToHexString,
  FarcasterNetwork,
  IdRegistryEventType,
  hexStringToBytes,
  HubError,
} from "@farcaster/hub-nodejs";
import { Transport, createPublicClient, http, parseEther, toHex } from "viem";
import { IdRegistry } from "./abis.js";
import { EthEventsProvider } from "./ethEventsProvider.js";
import { getIdRegistryEvent } from "../storage/db/idRegistryEvent.js";
import { jestRocksDB } from "../storage/db/jestUtils.js";
import Engine from "../storage/engine/index.js";
import { MockHub } from "../test/mocks.js";
import { deployIdRegistry, publicClient, testClient, walletClientWithAccount } from "../test/utils.js";
import { accounts } from "../test/constants.js";
import { sleep } from "../utils/crypto.js";
import { goerli } from "viem/chains";

const db = jestRocksDB("protobufs.ethEventsProvider.test");
const engine = new Engine(db, FarcasterNetwork.TESTNET);
const hub = new MockHub(db, engine);

let ethEventsProvider: EthEventsProvider;
let idRegistryAddress: `0x${string}`;

const generateEthAddressHex = () => {
  return bytesToHexString(Factories.EthAddress.build())._unsafeUnwrap() as `0x${string}`;
};

beforeAll(() => {
  // Poll aggressively for fast testing
  EthEventsProvider.blockPollingInterval = 10;
  EthEventsProvider.eventPollingInterval = 10;
});

afterAll(async () => {
  await engine.stop();
});

describe("EthEventsProvider", () => {
  describe("start", () => {
    test("throws if cannot connect to eth RPC provider", async () => {
      ethEventsProvider = new EthEventsProvider(
        hub,
        createPublicClient({ chain: goerli, transport: http("bad-url") }),
        idRegistryAddress,
        1,
        10000,
        false,
      );

      await expect(ethEventsProvider.start()).rejects.toThrowError(HubError);
    });
  });

  describe("build", () => {
    test("handles single RPC URL", () => {
      const ethEventsProvider = EthEventsProvider.build(
        hub,
        "http://some-url",
        false,
        idRegistryAddress,
        1,
        10000,
        false,
      );

      const transports = (ethEventsProvider["_publicClient"].transport as unknown as { transports: Transport[] })
        .transports;

      expect(transports.length).toBe(1);
    });

    test("handles multiple RPC URLs", () => {
      const ethEventsProvider = EthEventsProvider.build(
        hub,
        "http://some-url,http://some-other-url",
        false,
        idRegistryAddress,
        1,
        10000,
        false,
      );

      const transports = (ethEventsProvider["_publicClient"].transport as unknown as { transports: Transport[] })
        .transports;

      expect(transports.length).toBe(2);
    });
  });

  describe("process events", () => {
    beforeEach(async () => {
      const { contractAddress: idAddr } = await deployIdRegistry();
      if (!idAddr) throw new Error("Failed to deploy Id contract");
      idRegistryAddress = idAddr;

      ethEventsProvider = new EthEventsProvider(hub, publicClient, idRegistryAddress, 1, 10000, false);

      await ethEventsProvider.start();
    });

    afterEach(async () => {
      await ethEventsProvider.stop();
    });

    const waitForBlock = async (blockNumber: number) => {
      while (ethEventsProvider.getLatestBlockNumber() <= blockNumber) {
        // Wait for all async promises to resolve
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    test("handles new blocks", async () => {
      await testClient.mine({ blocks: 1 });
      const latestBlockNumber = await publicClient.getBlockNumber();
      await waitForBlock(Number(latestBlockNumber));
      expect(ethEventsProvider.getLatestBlockNumber()).toBeGreaterThanOrEqual(latestBlockNumber);
    });

    test("processes IdRegistry events", async () => {
      const address1 = generateEthAddressHex();
      const address2 = generateEthAddressHex();
      const changeTrustedCallerSim = await publicClient.simulateContract({
        address: idRegistryAddress,
        abi: IdRegistry.abi,
        functionName: "changeTrustedCaller",
        account: accounts[0].address,
        args: [accounts[0].address as `0x${string}`],
      });
      const changeTrustedCallerHash = await walletClientWithAccount.writeContract(changeTrustedCallerSim.request);
      await publicClient.waitForTransactionReceipt({ hash: changeTrustedCallerHash });

      const registerSim = await publicClient.simulateContract({
        address: idRegistryAddress,
        abi: IdRegistry.abi,
        functionName: "trustedRegister",
        account: accounts[0].address,
        args: [address1 as `0x${string}`, address2 as `0x${string}`, ""],
      });

      const registerHash = await walletClientWithAccount.writeContract(registerSim.request);
      const registerTrx = await publicClient.waitForTransactionReceipt({ hash: registerHash });
      await sleep(1000); // allow time for the register event to be polled for

      // The event is not immediately available, since it has to wait for confirmations
      await expect(getIdRegistryEvent(db, 1)).rejects.toThrow();
      await testClient.mine({ blocks: 7 });

      // Wait for the register block to be confirmed
      await waitForBlock(Number(registerTrx.blockNumber) + EthEventsProvider.numConfirmations);
      const idRegistryEvent = await getIdRegistryEvent(db, 1);
      expect(idRegistryEvent.fid).toEqual(1);

      await testClient.setBalance({
        address: address1,
        value: parseEther("1"),
      });
      await testClient.impersonateAccount({
        address: address1,
      });
      const transferSim = await publicClient.simulateContract({
        address: idRegistryAddress,
        abi: IdRegistry.abi,
        functionName: "transfer",
        account: address1,
        args: [address2 as `0x${string}`],
      });
      const transferHash = await walletClientWithAccount.writeContract(transferSim.request);
      const transferTrx = await publicClient.waitForTransactionReceipt({ hash: transferHash });
      await sleep(1000); // allow time for the register event to be polled for

      // Wait for the transfer block to be confirmed
      await testClient.mine({ blocks: 7 });
      await waitForBlock(Number(transferTrx.blockNumber) + EthEventsProvider.numConfirmations);

      const postTransferIdRegistryEvent = await getIdRegistryEvent(db, 1);
      expect(postTransferIdRegistryEvent.fid).toEqual(1);
      expect(postTransferIdRegistryEvent.type).toEqual(IdRegistryEventType.TRANSFER);
      expect(postTransferIdRegistryEvent.to).toEqual(hexStringToBytes(address2)._unsafeUnwrap());
    });
  });
});
