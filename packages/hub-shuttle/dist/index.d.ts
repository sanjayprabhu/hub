import * as _farcaster_hub_nodejs from "@farcaster/hub-nodejs";
import {
  ReactionType,
  UserDataType,
  UserNameType,
  MessageType,
  HashScheme,
  SignatureScheme,
  HubRpcClient,
  HubEventType,
  HubEvent,
  Message,
} from "@farcaster/hub-nodejs";
import * as kysely from "kysely";
import {
  Selectable,
  Insertable,
  Kysely,
  SelectQueryBuilder,
  InsertQueryBuilder,
  UpdateQueryBuilder,
  DeleteQueryBuilder,
  NoResultErrorConstructor,
  QueryNode,
  Transaction,
  Generated,
} from "kysely";
import { DrainOuterGeneric, SimplifySingleResult } from "kysely/dist/cjs/util/type-utils.js";
import { RedisOptions, Redis } from "ioredis";
import { pino } from "pino";
import { TypedEmitter } from "tiny-typed-emitter";

type Fid = number;
type Hex = `0x${string}`;
type VerificationProtocol = "ethereum" | "solana";
type CastIdJson = {
  fid: Fid;
  hash: Hex;
};
type CastAddBodyJson = {
  text: string;
  embeds?: string[];
  mentions?: number[];
  mentionsPositions?: number[];
  parent?: CastIdJson | string;
};
type CastRemoveBodyJson = {
  targetHash: string;
};
type ReactionBodyJson = {
  type: ReactionType;
  target: CastIdJson | string;
};
type VerificationAddEthAddressBodyJson = {
  address: string;
  claimSignature: string;
  blockHash: string;
  protocol: string;
};
type VerificationRemoveBodyJson = {
  address: string;
};
type SignerAddBodyJson = {
  signer: string;
  name: string;
};
type SignerRemoveBodyJson = {
  signer: string;
};
type UserDataBodyJson = {
  type: UserDataType;
  value: string;
};
type LinkBodyJson = {
  type: string;
  /** original timestamp in Unix ms */
  displayTimestamp?: number;
  targetFid?: number;
};
type UsernameProofBodyJson = {
  timestamp: number;
  name: string;
  owner: string;
  signature: string;
  fid: number;
  type: UserNameType;
};
type MessageBodyJson =
  | CastAddBodyJson
  | CastRemoveBodyJson
  | ReactionBodyJson
  | LinkBodyJson
  | VerificationAddEthAddressBodyJson
  | VerificationRemoveBodyJson
  | SignerAddBodyJson
  | SignerRemoveBodyJson
  | UserDataBodyJson
  | UsernameProofBodyJson;
type MessagesTable = {
  id: Generated<string>;
  fid: number;
  type: MessageType;
  timestamp: Date;
  hashScheme: HashScheme;
  signatureScheme: SignatureScheme;
  hash: Uint8Array;
  signer: Uint8Array;
  raw: Uint8Array;
  body: MessageBodyJson;
  deletedAt: Date | null;
  revokedAt: Date | null;
  prunedAt: Date | null;
};
type MessageRow = Selectable<MessagesTable>;
type InsertableMessageRow = Insertable<MessagesTable>;
interface HubTables {
  messages: MessagesTable;
}
declare const getDbClient: (connectionString?: string) => Kysely<HubTables>;
declare function execute<DB, UT extends keyof DB, TB extends keyof DB, O>(
  query:
    | SelectQueryBuilder<DB, TB, O>
    | InsertQueryBuilder<DB, TB, O>
    | UpdateQueryBuilder<DB, UT, TB, O>
    | DeleteQueryBuilder<DB, TB, O>,
): Promise<
  DrainOuterGeneric<{
    [K in keyof O]: O[K];
  }>[]
>;
declare function executeTakeFirst<DB, UT extends keyof DB, TB extends keyof DB, O>(
  query:
    | SelectQueryBuilder<DB, TB, O>
    | InsertQueryBuilder<DB, TB, O>
    | UpdateQueryBuilder<DB, UT, TB, O>
    | DeleteQueryBuilder<DB, TB, O>,
): Promise<SimplifySingleResult<O>>;
declare function executeTakeFirstOrThrow<DB, UT extends keyof DB, TB extends keyof DB, O>(
  query:
    | SelectQueryBuilder<DB, TB, O>
    | InsertQueryBuilder<DB, TB, O>
    | UpdateQueryBuilder<DB, UT, TB, O>
    | DeleteQueryBuilder<DB, TB, O>,
  errorConstructor?: NoResultErrorConstructor | ((node: QueryNode) => Error) | undefined,
): Promise<
  DrainOuterGeneric<{
    [K in keyof O]: O[K];
  }>
>;
declare function executeTx<T>(db: DB, callback: (trx: DBTransaction) => Promise<T>): Promise<T>;
declare function stream<DB, UT extends keyof DB, TB extends keyof DB, O>(
  query:
    | SelectQueryBuilder<DB, TB, O>
    | InsertQueryBuilder<DB, TB, O>
    | UpdateQueryBuilder<DB, UT, TB, O>
    | DeleteQueryBuilder<DB, TB, O>,
  fn: (row: O) => Promise<void> | void,
): Promise<void>;
declare function getEstimateOfTablesRowCount(
  db: DB,
  tablesToMonitor: Array<keyof HubTables>,
): Promise<
  kysely.QueryResult<{
    tableName: string;
    estimate: number;
  }>
>;
type DBTransaction = Transaction<HubTables>;
type DB = Kysely<HubTables>;

declare const getRedisClient: (redisUrl: string, redisOpts?: RedisOptions) => Redis;
declare class RedisClient {
  private client;
  constructor(client: Redis);
  static create(redisUrl: string, redisOpts?: RedisOptions): RedisClient;
  setLastProcessedEvent(hubId: string, eventId: number): Promise<void>;
  getLastProcessedEvent(hubId: string): Promise<number>;
  clearForTest(): Promise<void>;
}

declare function getHubClient(
  host: string,
  {
    ssl,
  }: {
    ssl?: boolean;
  },
): _farcaster_hub_nodejs.HubRpcClient;

type Logger = pino.Logger;

interface HubEventsEmitter {
  event: (hubEvent: HubEvent) => void;
  onError: (error: Error, stopped: boolean) => void;
}
declare abstract class HubSubscriber extends TypedEmitter<HubEventsEmitter> {
  readonly hubClient?: HubRpcClient;
  start(fromId?: number): Promise<void>;
  stop(): void;
  destroy(): void;
}
declare class HubSubscriberImpl extends HubSubscriber {
  label: string;
  hubClient: HubRpcClient;
  stopped: boolean;
  private log;
  private eventTypes;
  private stream;
  constructor(label: string, hubClient: HubRpcClient, log: Logger, eventTypes?: HubEventType[]);
  stop(): void;
  destroy(): void;
  private _waitForReadyHubClient;
  start(fromId?: number): Promise<void>;
  private processStream;
}

declare class HubEventProcessor {
  static processHubEvent(db: DB, event: HubEvent, handler: MessageHandler): Promise<void>;
  static handleMissingMessage(db: DB, message: Message, handler: MessageHandler): Promise<void>;
  private static processMergeMessage;
}

declare class MessageProcessor {
  static storeMessage(
    message: Message,
    trx: DB,
    operation?: StoreMessageOperation,
    log?: pino.Logger | undefined,
  ): Promise<boolean>;
}

declare class MessageReconciliation {
  private client;
  private db;
  private log;
  constructor(client: HubRpcClient, db: DB, log: pino.Logger);
  reconcileMessagesForFid(
    fid: number,
    onHubMessage: (message: Message, missingInDb: boolean, prunedInDb: boolean, revokedInDb: boolean) => Promise<void>,
  ): Promise<void>;
  reconcileMessagesOfTypeForFid(
    fid: number,
    type: MessageType,
    onHubMessage: (message: Message, missingInDb: boolean, prunedInDb: boolean, revokedInDb: boolean) => Promise<void>,
  ): Promise<void>;
  private allHubMessagesOfTypeForFid;
  private getAllCastMessagesByFidInBatchesOf;
  private getAllReactionMessagesByFidInBatchesOf;
  private getAllLinkMessagesByFidInBatchesOf;
  private getAllVerificationMessagesByFidInBatchesOf;
  private getAllUserDataMessagesByFidInBatchesOf;
}

type StoreMessageOperation = "merge" | "delete" | "revoke" | "prune";
interface MessageHandler {
  handleMessageMerge(message: Message, txn: DB, operation: StoreMessageOperation, wasMissed: boolean): Promise<void>;
}

export {
  CastAddBodyJson,
  CastRemoveBodyJson,
  DB,
  DBTransaction,
  Fid,
  Hex,
  HubEventProcessor,
  HubSubscriber,
  HubSubscriberImpl,
  HubTables,
  InsertableMessageRow,
  LinkBodyJson,
  MessageBodyJson,
  MessageHandler,
  MessageProcessor,
  MessageReconciliation,
  MessageRow,
  ReactionBodyJson,
  RedisClient,
  SignerAddBodyJson,
  SignerRemoveBodyJson,
  StoreMessageOperation,
  UserDataBodyJson,
  UsernameProofBodyJson,
  VerificationAddEthAddressBodyJson,
  VerificationProtocol,
  VerificationRemoveBodyJson,
  execute,
  executeTakeFirst,
  executeTakeFirstOrThrow,
  executeTx,
  getDbClient,
  getEstimateOfTablesRowCount,
  getHubClient,
  getRedisClient,
  stream,
};
