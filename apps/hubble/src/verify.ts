import { IdRegistryV2, KeyRegistry, StorageRegistry } from "./eth/abis.js";
import { createPublicClient, fallback, http, Log, OnLogsParameter } from "viem";
import { optimism } from "viem/chains";
import { OptimismConstants } from "./eth/l2EventsProvider.js";
import { ExtractAbiEvent } from "abitype";
import {
  bytesToHexString,
  getInsecureHubRpcClient,
  hexStringToBytes,
  IdRegisterEventBody,
  IdRegisterEventType,
  OnChainEventType,
} from "@farcaster/hub-nodejs";
import { bytesCompare } from "@farcaster/core";

const publicClient = createPublicClient({
  chain: optimism,
  transport: fallback([http("https://opt-mainnet.g.alchemy.com/v2/3xWX-cWV-an3IPXmVCRXX51PpQzc-8iJ")]),
});

const idRegisterByFid = new Map<number, IdRegisterEventBody>();
const storageUnitsByFid = new Map<number, number>();
const signersByFid = new Map<number, Set<string>>();

const processIdRegistryEvents = async (logs: OnLogsParameter<any, true, string>) => {
  for (const event of logs) {
    const { blockNumber, blockHash, transactionHash, transactionIndex } = event;

    // Do nothing if the block is pending
    if (blockHash === null || blockNumber === null || transactionHash === null || transactionIndex === null) {
      throw new Error("Block is pending");
    }

    try {
      if (event.eventName === "Register") {
        const registerEvent = event as Log<
          bigint,
          number,
          ExtractAbiEvent<typeof IdRegistryV2.abi, "Register">,
          true,
          typeof IdRegistryV2.abi
        >;
        const idRegisterEventBody = IdRegisterEventBody.create({
          eventType: IdRegisterEventType.REGISTER,
          to: hexStringToBytes(registerEvent.args.to)._unsafeUnwrap(),
          recoveryAddress: hexStringToBytes(registerEvent.args.recovery)._unsafeUnwrap(),
        });
        idRegisterByFid.set(Number(registerEvent.args.id), idRegisterEventBody);
      } else if (event.eventName === "Transfer") {
        // const transferEvent = event as Log<
        //   bigint,
        //   number,
        //   ExtractAbiEvent<typeof IdRegistryV2.abi, "Transfer">,
        //   true,
        //   typeof IdRegistryV2.abi
        // >;
        // const idRegisterEventBody = IdRegisterEventBody.create({
        //   eventType: IdRegisterEventType.TRANSFER,
        //   to: hexStringToBytes(transferEvent.args.to)._unsafeUnwrap(),
        //   from: hexStringToBytes(transferEvent.args.from)._unsafeUnwrap(),
        // });
        throw new Error("Unexpected transfer event");
      } else if (event.eventName === "ChangeRecoveryAddress") {
        // const transferEvent = event as Log<
        //   bigint,
        //   number,
        //   ExtractAbiEvent<typeof IdRegistryV2.abi, "ChangeRecoveryAddress">,
        //   true,
        //   typeof IdRegistryV2.abi
        // >;
        // const idRegisterEventBody = IdRegisterEventBody.create({
        //   eventType: IdRegisterEventType.CHANGE_RECOVERY,
        //   recoveryAddress: hexStringToBytes(transferEvent.args.recovery)._unsafeUnwrap(),
        // });
        throw new Error("Unexpected change recovery event");
      }
    } catch (e) {
      throw new Error(`Failed to process id registry event: ${e}`);
    }
  }
};

const processStorageEvents = async (logs: OnLogsParameter<any, true, string>) => {
  for (const event of logs) {
    const { blockNumber, blockHash, transactionHash, transactionIndex } = event;

    // Do nothing if the block is pending
    if (blockHash === null || blockNumber === null || transactionHash === null || transactionIndex === null) {
      throw new Error("Block is pending");
    }

    // Handling: use try-catch + log since errors are expected and not important to surface
    try {
      if (event.eventName === "Rent") {
        // Fix when viem fixes https://github.com/wagmi-dev/viem/issues/938
        const rentEvent = event as Log<
          bigint,
          number,
          ExtractAbiEvent<typeof StorageRegistry.abi, "Rent">,
          true,
          typeof StorageRegistry.abi
        >;
        const newCount = (storageUnitsByFid.get(Number(rentEvent.args.fid)) || 0) + Number(rentEvent.args.units);
        storageUnitsByFid.set(Number(rentEvent.args.fid), newCount);
      }
    } catch (e) {
      throw new Error(`Failed to process storage registry event: ${e}`);
    }
  }
};

const processKeyRegistryEvents = async (logs: OnLogsParameter<any, true, string>) => {
  for (const event of logs) {
    const { blockNumber, blockHash, transactionHash, transactionIndex } = event;

    // Do nothing if the block is pending
    if (blockHash === null || blockNumber === null || transactionHash === null || transactionIndex === null) {
      throw new Error("Block is pending");
    }

    // Handling: use try-catch + log since errors are expected and not important to surface
    try {
      if (event.eventName === "Add") {
        const addEvent = event as Log<
          bigint,
          number,
          ExtractAbiEvent<typeof KeyRegistry.abi, "Add">,
          true,
          typeof KeyRegistry.abi
        >;
        // const signerEventBody = SignerEventBody.create({
        //   eventType: SignerEventType.ADD,
        //   key: hexStringToBytes(addEvent.args.keyBytes)._unsafeUnwrap(),
        //   keyType: addEvent.args.keyType,
        //   metadata: hexStringToBytes(addEvent.args.metadata)._unsafeUnwrap(),
        //   metadataType: addEvent.args.metadataType,
        // });
        if (!signersByFid.has(Number(addEvent.args.fid))) {
          signersByFid.set(Number(addEvent.args.fid), new Set());
        }
        signersByFid.get(Number(addEvent.args.fid))!.add(addEvent.args.keyBytes);
      } else if (event.eventName === "Remove") {
        // const removeEvent = event as Log<
        //   bigint,
        //   number,
        //   ExtractAbiEvent<typeof KeyRegistry.abi, "Remove">,
        //   true,
        //   typeof KeyRegistry.abi
        // >;
        throw new Error("Unexpected remove event");
      } else if (event.eventName === "AdminReset") {
        const resetEvent = event as Log<
          bigint,
          number,
          ExtractAbiEvent<typeof KeyRegistry.abi, "AdminReset">,
          true,
          typeof KeyRegistry.abi
        >;
        // const signerEventBody = SignerEventBody.create({
        //   eventType: SignerEventType.ADMIN_RESET,
        //   key: hexStringToBytes(resetEvent.args.keyBytes)._unsafeUnwrap(),
        // });
        signersByFid.get(Number(resetEvent.args.fid))!.delete(resetEvent.args.keyBytes);
      } else if (event.eventName === "Migrated") {
        // const migratedEvent = event as Log<
        //   bigint,
        //   number,
        //   ExtractAbiEvent<typeof KeyRegistry.abi, "Migrated">,
        //   true,
        //   typeof KeyRegistry.abi
        // >;
        throw new Error("Unexpected migrated event");
      }
    } catch (e) {
      throw new Error(`Failed to process key registry event: ${e}`);
    }
  }
};

const syncHistoricalEvents = async (fromBlock: number, toBlock: number, batchSize: number) => {
  // Calculate amount of runs required based on batchSize, and round up to capture all blocks
  const totalBlocks = toBlock - fromBlock;
  const numOfRuns = Math.ceil(totalBlocks / batchSize);

  for (let i = 0; i < numOfRuns; i++) {
    let nextFromBlock = fromBlock + i * batchSize;
    const nextToBlock = nextFromBlock + batchSize;

    if (i > 0) {
      // If this isn't our first loop, we need to up the fromBlock by 1, or else we will be re-caching an already cached block.
      nextFromBlock += 1;
    }

    const idFilter = await publicClient.createContractEventFilter({
      address: OptimismConstants.IdRegistryAddress,
      abi: IdRegistryV2.abi,
      fromBlock: BigInt(nextFromBlock),
      toBlock: BigInt(nextToBlock),
      strict: true,
    });
    const idLogsPromise = publicClient.getFilterLogs({ filter: idFilter });

    const storageFilter = await publicClient.createContractEventFilter({
      address: OptimismConstants.StorageRegistryAddress,
      abi: StorageRegistry.abi,
      fromBlock: BigInt(nextFromBlock),
      toBlock: BigInt(nextToBlock),
      strict: true,
    });
    const storageLogsPromise = publicClient.getFilterLogs({
      filter: storageFilter,
    });

    const keyFilter = await publicClient.createContractEventFilter({
      address: OptimismConstants.KeyRegistryAddress,
      abi: KeyRegistry.abi,
      fromBlock: BigInt(nextFromBlock),
      toBlock: BigInt(nextToBlock),
      strict: true,
    });
    const keyLogsPromise = publicClient.getFilterLogs({ filter: keyFilter });

    await processIdRegistryEvents(await idLogsPromise);
    await processStorageEvents(await storageLogsPromise);
    await processKeyRegistryEvents(await keyLogsPromise);
  }
};

(async () => {
  // first block: 108869032n
  // latest block: 108906580
  await syncHistoricalEvents(OptimismConstants.FirstBlock, 108906580, 1000);

  console.log(
    `idRegisters: ${idRegisterByFid.size}, storageUnits: ${storageUnitsByFid.size}, signers: ${signersByFid.size}`,
  );
  const client = getInsecureHubRpcClient("34.125.44.148:2283");
  for (const id of idRegisterByFid.keys()) {
    const register = await client.getOnChainEvents({ fid: id, eventType: OnChainEventType.EVENT_TYPE_ID_REGISTER });
    const storage = await client.getOnChainEvents({ fid: id, eventType: OnChainEventType.EVENT_TYPE_STORAGE_RENT });
    const signer = await client.getOnChainSignersByFid({ fid: id });
    if (register.isErr() || storage.isErr() || signer.isErr()) {
      console.log(`failed to get register for id`, id);
      console.log(register._unsafeUnwrapErr());
      continue;
    }
    if (register.value.events.length !== 1) {
      console.log("invalid register length for id", id);
    }

    const registerEvent = register.value.events[0];
    if (bytesCompare(idRegisterByFid.get(id)!.to, registerEvent!.idRegisterEventBody!.to) !== 0) {
      console.log(
        `invalid register to for id: ${id} (expected: ${bytesToHexString(
          idRegisterByFid.get(id)!.to,
        )._unsafeUnwrap()}, actual: ${bytesToHexString(registerEvent!.idRegisterEventBody!.to)._unsafeUnwrap()})`,
      );
    }
    const storageEvent = storage.value.events[0];
    if (storageEvent!.storageRentEventBody!.units !== storageUnitsByFid.get(id)) {
      console.log(
        `Invalid storage units for id: ${id} (expected: ${storageUnitsByFid.get(id)}, actual: ${
          storageEvent!.storageRentEventBody!.units
        })`,
      );
    }
    const signers = signer.value.events;
    if (signers.length !== signersByFid.get(id)!.size) {
      console.log(`Invalid signers for id: ${id} (expected: ${signersByFid.get(id)!.size}, actual: ${signers.length})`);
    }

    for (const contractSigner of signersByFid.get(id)!) {
      if (
        !signers.some(
          (s) => bytesCompare(s.signerEventBody!.key, hexStringToBytes(contractSigner)._unsafeUnwrap()) === 0,
        )
      ) {
        console.log(
          `Invalid signer for id: ${id} (expected: ${contractSigner}, actual: ${signers.map((s) =>
            bytesToHexString(s.signerEventBody!.key)._unsafeUnwrap(),
          )})`,
        );
      }
    }

    if (id % 250 === 0) {
      console.log(`verified ${id}`);
    }
  }
  console.log("done");
})();
