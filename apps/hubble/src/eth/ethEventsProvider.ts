import {
  hexStringToBytes,
  HubAsyncResult,
  HubError,
  IdRegistryEvent,
  IdRegistryEventType,
} from "@farcaster/hub-nodejs";
import { createPublicClient, fallback, http, Log, PublicClient } from "viem";
import { goerli } from "viem/chains";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { IdRegistry } from "./abis.js";
import { HubInterface } from "../hubble.js";
import { logger } from "../utils/logger.js";
import { WatchContractEvent } from "./watchContractEvent.js";
import { WatchBlockNumber } from "./watchBlockNumber.js";

const log = logger.child({
  component: "EthEventsProvider",
});

export class GoerliEthConstants {
  public static IdRegistryAddress = "0xda107a1caf36d198b12c16c7b6a1d1c795978c42" as const;
  public static FirstBlock = 7648795;
  public static ChunkSize = 1000;
}

/**
 * Class that follows the Ethereum chain to handle on-chain events from the ID
 * Registry and Name Registry contracts.
 */
export class EthEventsProvider {
  private _hub: HubInterface;
  private _publicClient: PublicClient;

  private _firstBlock: number;
  private _chunkSize: number;
  private _resyncEvents: boolean;

  private _idEventsByBlock: Map<number, Array<IdRegistryEvent>>;
  private _retryDedupMap: Map<number, boolean>;

  private _lastBlockNumber: number;

  private _watchIdRegistryRegisters: WatchContractEvent<typeof IdRegistry.abi, "Register", true>;
  private _watchIdRegistryTransfers: WatchContractEvent<typeof IdRegistry.abi, "Transfer", true>;
  private _watchBlockNumber: WatchBlockNumber;

  // Whether the historical events have been synced. This is used to avoid
  // syncing the events multiple times.
  private _isHistoricalSyncDone = false;

  // Number of blocks to wait before processing an event. This is hardcoded to
  // 3 for now, since we're on testnet and we want to recognize user
  // registration events as quickly as possible without introducing too much
  // risk due to block reorganization.
  // Once we move registration to an L2 this will be less of a concern.
  static numConfirmations = 3;

  // Events are only processed after 6 blocks have been confirmed; poll less
  // frequently while ensuring events are available the moment they are
  // confirmed.
  static eventPollingInterval = (EthEventsProvider.numConfirmations - 2) * 12_000;
  static blockPollingInterval = 4_000;

  constructor(
    hub: HubInterface,
    publicClient: PublicClient,
    idRegistryAddress: `0x${string}`,
    firstBlock: number,
    chunkSize: number,
    resyncEvents: boolean,
  ) {
    this._hub = hub;
    this._publicClient = publicClient;
    this._firstBlock = firstBlock;
    this._chunkSize = chunkSize;
    this._resyncEvents = resyncEvents;

    this._lastBlockNumber = 0;

    // Initialize the cache for the ID and Name Registry events. They will be
    // processed after numConfirmations blocks have been mined.
    this._idEventsByBlock = new Map();
    this._retryDedupMap = new Map();

    // Setup IdRegistry contract
    this._watchIdRegistryRegisters = new WatchContractEvent(
      this._publicClient,
      {
        address: idRegistryAddress,
        abi: IdRegistry.abi,
        eventName: "Register",
        onLogs: this.processIdRegisterEvents.bind(this),
        pollingInterval: EthEventsProvider.eventPollingInterval,
        strict: true,
      },
      "IdRegistry Register",
    );

    this._watchIdRegistryTransfers = new WatchContractEvent(
      this._publicClient,
      {
        address: idRegistryAddress,
        abi: IdRegistry.abi,
        eventName: "Transfer",
        onLogs: this.processIdTransferEvents.bind(this),
        pollingInterval: EthEventsProvider.eventPollingInterval,
        strict: true,
      },
      "IdRegistry Transfer",
    );

    this._watchBlockNumber = new WatchBlockNumber(this._publicClient, {
      pollingInterval: EthEventsProvider.blockPollingInterval,
      onBlockNumber: (blockNumber) => this.handleNewBlock(Number(blockNumber)),
      onError: (error) => {
        log.error(`Error watching new block numbers: ${error}`, { error });
      },
    });
  }

  public static build(
    hub: HubInterface,
    ethRpcUrl: string,
    rankRpcs: boolean,
    idRegistryAddress: `0x${string}`,
    firstBlock: number,
    chunkSize: number,
    resyncEvents: boolean,
  ): EthEventsProvider {
    const ethRpcUrls = ethRpcUrl.split(",");
    const transports = ethRpcUrls.map((url) => http(url, { retryCount: 5 }));

    const publicClient = createPublicClient({
      chain: goerli,
      transport: fallback(transports, { rank: rankRpcs }),
    });

    const provider = new EthEventsProvider(hub, publicClient, idRegistryAddress, firstBlock, chunkSize, resyncEvents);

    return provider;
  }

  public getLatestBlockNumber(): number {
    return this._lastBlockNumber;
  }

  public async start() {
    // Connect to Ethereum RPC
    await this.connectAndSyncHistoricalEvents();

    this._watchBlockNumber.start();
    this._watchIdRegistryRegisters.start();
    this._watchIdRegistryTransfers.start();
  }

  public async stop() {
    this._watchIdRegistryRegisters.stop();
    this._watchIdRegistryTransfers.stop();
    this._watchBlockNumber.stop();

    // Wait for all async promises to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /* -------------------------------------------------------------------------- */
  /*                               Private Methods                              */
  /* -------------------------------------------------------------------------- */

  /** Connect to Ethereum RPC */
  private async connectAndSyncHistoricalEvents() {
    const latestBlockResult = await ResultAsync.fromPromise(this._publicClient.getBlockNumber(), (err) => err);
    if (latestBlockResult.isErr()) {
      logger.fatal(latestBlockResult.error);
      logger.fatal("Failed to connect to ethereum node. Check your eth RPC URL (e.g. --eth-rpc-url)");
      throw new HubError("unknown", {
        message: "Failed to connect to ethereum node.",
        cause: latestBlockResult.error as Error,
      });
    }

    const latestBlock = Number(latestBlockResult.value);

    if (!latestBlock) {
      log.error("failed to get the latest block from the RPC provider");
      return;
    }

    log.info({ latestBlock: latestBlock }, "connected to ethereum node");

    // Find how how much we need to sync
    let lastSyncedBlock = this._firstBlock;

    const hubState = await this._hub.getHubState();
    if (hubState.isOk()) {
      lastSyncedBlock = hubState.value.lastEthBlock;
    }

    if (this._resyncEvents) {
      log.info(`Resyncing events from ${this._firstBlock} instead of ${lastSyncedBlock}`);
      lastSyncedBlock = this._firstBlock;
    }

    log.info({ lastSyncedBlock }, "last synced block");
    const toBlock = latestBlock;

    if (lastSyncedBlock < toBlock) {
      log.info({ fromBlock: lastSyncedBlock, toBlock }, "syncing events from missed blocks");

      // Sync old Id events
      await this.syncHistoricalIdEvents(IdRegistryEventType.REGISTER, lastSyncedBlock, toBlock, this._chunkSize);
      await this.syncHistoricalIdEvents(IdRegistryEventType.TRANSFER, lastSyncedBlock, toBlock, this._chunkSize);
    }

    this._isHistoricalSyncDone = true;
  }

  /**
   * Retry events from a specific block number
   *
   * @param blockNumber
   */
  public async retryEventsFromBlock(blockNumber: number) {
    if (this._retryDedupMap.has(blockNumber)) {
      return;
    }
    this._retryDedupMap.set(blockNumber, true);
    await this.syncHistoricalIdEvents(IdRegistryEventType.REGISTER, blockNumber, blockNumber + 1, 1);
    await this.syncHistoricalIdEvents(IdRegistryEventType.TRANSFER, blockNumber, blockNumber + 1, 1);
  }

  /**
   * Sync old Id events that may have happened before hub was started. We'll put them all
   * in the sync queue to be processed later, to make sure we don't process any unconfirmed events.
   */
  private async syncHistoricalIdEvents(
    type: IdRegistryEventType,
    fromBlock: number,
    toBlock: number,
    batchSize: number,
  ) {
    /*
     * How querying blocks in batches works
     * We calculate the difference in blocks, for example, lets say we need to sync/cache 769,531 blocks (difference between the contracts FirstBlock, and the latest Goerli block at time of writing, 8418326)
     * After that, we divide our difference in blocks by the batchSize. For example, over 769,531 blocks, at a 10,000 block batchSize, we need to run our loop 76.9531 times, which obviously just rounds up to 77 loops
     * During this whole process, we're using a for(let i=0;) loop, which means to get the correct from block, we need to calculate new fromBlock's and toBlock's on every loop
     * fromBlock: FirstBlock + (loopIndex * batchSize) - Example w/ batchSize 10,000: Run 0 - FirstBlock + 0, Run 1 - FirstBlock + 10,000, Run 2 - FirstBlock + 20,000, etc....
     * toBlock: fromBlock + batchSize - Example w/ batchSize 10,000: Run 0: fromBlock + 10,000, Run 1 - fromBlock + 10,000, etc...
     */

    // Calculate amount of runs required based on batchSize, and round up to capture all blocks
    const numOfRuns = Math.ceil((toBlock - fromBlock) / batchSize);

    for (let i = 0; i < numOfRuns; i++) {
      let nextFromBlock = fromBlock + i * batchSize;
      const nextToBlock = nextFromBlock + batchSize;

      if (i > 0) {
        // If this isn't our first loop, we need to up the fromBlock by 1, or else we will be re-caching an already cached block.
        nextFromBlock += 1;
      }

      if (type === IdRegistryEventType.REGISTER) {
        const filter = await this._publicClient.createContractEventFilter({
          address: GoerliEthConstants.IdRegistryAddress,
          abi: IdRegistry.abi,
          eventName: "Register",
          fromBlock: BigInt(nextFromBlock),
          toBlock: BigInt(nextToBlock),
          strict: true,
        });

        const logs = await this._publicClient.getFilterLogs({ filter });
        await this.processIdRegisterEvents(logs);
      } else if (type === IdRegistryEventType.TRANSFER) {
        const filter = await this._publicClient.createContractEventFilter({
          address: GoerliEthConstants.IdRegistryAddress,
          abi: IdRegistry.abi,
          eventName: "Transfer",
          fromBlock: BigInt(nextFromBlock),
          toBlock: BigInt(nextToBlock),
          strict: true,
        });

        const logs = await this._publicClient.getFilterLogs({ filter });
        await this.processIdTransferEvents(logs);
      }
    }
  }

  private async processIdTransferEvents(
    logs: Log<bigint, number, undefined, true, typeof IdRegistry.abi, "Transfer">[],
  ) {
    for (const event of logs) {
      const { blockNumber, blockHash, transactionHash, transactionIndex } = event;

      // Do nothing if the block is pending
      if (blockHash === null || blockNumber === null || transactionHash === null || transactionIndex === null) {
        continue;
      }

      // Handling: use try-catch + log since errors are expected and not important to surface
      try {
        await this.cacheIdRegistryEvent(
          event.args.from,
          event.args.to,
          event.args.id,
          IdRegistryEventType.TRANSFER,
          Number(blockNumber),
          blockHash,
          transactionHash,
          Number(transactionIndex),
        );
      } catch (e) {
        log.error({ event }, "failed to parse event args");
      }
    }
  }

  private async processIdRegisterEvents(
    logs: Log<bigint, number, undefined, true, typeof IdRegistry.abi, "Register">[],
  ) {
    for (const event of logs) {
      const { blockNumber, blockHash, transactionHash, transactionIndex } = event;

      // Do nothing if the block is pending
      if (blockHash === null || blockNumber === null || transactionHash === null || transactionIndex === null) {
        continue;
      }

      // Handling: use try-catch + log since errors are expected and not important to surface
      try {
        await this.cacheIdRegistryEvent(
          null,
          event.args.to,
          event.args.id,
          IdRegistryEventType.REGISTER,
          Number(blockNumber),
          blockHash,
          transactionHash,
          Number(transactionIndex),
        );
      } catch (e) {
        log.error({ event }, "failed to parse event args");
      }
    }
  }

  /** Handle a new block. Processes all events in the cache that have now been confirmed */
  private async handleNewBlock(blockNumber: number) {
    log.info({ blockNumber }, `new block: ${blockNumber}`);

    // Get all blocks that have been confirmed into a single array and sort.
    const cachedBlocksSet = new Set([...this._idEventsByBlock.keys()]);
    const cachedBlocks = Array.from(cachedBlocksSet);
    cachedBlocks.sort();

    for (const cachedBlock of cachedBlocks) {
      if (cachedBlock + EthEventsProvider.numConfirmations <= blockNumber) {
        const idEvents = this._idEventsByBlock.get(cachedBlock);
        this._idEventsByBlock.delete(cachedBlock);

        if (idEvents) {
          for (const idEvent of idEvents) {
            await this._hub.submitIdRegistryEvent(idEvent, "eth-provider");
          }
        }
        this._retryDedupMap.delete(cachedBlock);
      }
    }

    // Update the last synced block if all the historical events have been synced
    if (this._isHistoricalSyncDone) {
      const hubState = await this._hub.getHubState();
      if (hubState.isOk()) {
        hubState.value.lastEthBlock = blockNumber;
        await this._hub.putHubState(hubState.value);
      } else {
        log.error({ errCode: hubState.error.errCode }, `failed to get hub state: ${hubState.error.message}`);
      }
    }

    this._lastBlockNumber = blockNumber;
  }

  private async cacheIdRegistryEvent(
    from: string | null,
    to: string,
    id: bigint,
    type: IdRegistryEventType,
    blockNumber: number,
    blockHash: string,
    transactionHash: string,
    index: number,
  ): HubAsyncResult<void> {
    const logEvent = log.child({ event: { to, id: id.toString(), blockNumber } });

    const serialized = Result.combine([
      from && from.length > 0 ? hexStringToBytes(from) : ok(new Uint8Array()),
      hexStringToBytes(blockHash),
      hexStringToBytes(transactionHash),
      hexStringToBytes(to),
    ]);

    if (serialized.isErr()) {
      logEvent.error({ errCode: serialized.error.errCode }, `cacheIdRegistryEvent error: ${serialized.error.message}`);
      return err(serialized.error);
    }

    const [fromBytes, blockHashBytes, transactionHashBytes, toBytes] = serialized.value;

    // Construct the protobuf
    const idRegistryEvent = IdRegistryEvent.create({
      blockNumber,
      blockHash: blockHashBytes,
      logIndex: index,
      fid: Number(id),
      to: toBytes,
      transactionHash: transactionHashBytes,
      type,
      from: fromBytes,
    });

    // Add it to the cache
    let idEvents = this._idEventsByBlock.get(blockNumber);
    if (!idEvents) {
      idEvents = [];
      this._idEventsByBlock.set(blockNumber, idEvents);
    }
    idEvents.push(idRegistryEvent);

    log.info(
      { event: { to, id: id.toString(), blockNumber } },
      `cacheIdRegistryEvent: fid ${id.toString()} assigned to ${to} in block ${blockNumber}`,
    );

    return ok(undefined);
  }
}
