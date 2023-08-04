import { UserNameProof } from "@farcaster/hub-nodejs";
import RocksDB, { Transaction } from "../db/rocksdb.js";
import { RootPrefix } from "../db/types.js";

export const makeFNameUserNameProofKey = (name: Uint8Array): Buffer => {
  return Buffer.concat([Buffer.from([RootPrefix.FNameUserNameProof]), Buffer.from(name)]);
};

export const getUserNameProof = async (db: RocksDB, name: Uint8Array): Promise<UserNameProof> => {
  const primaryKey = makeFNameUserNameProofKey(name);
  const buffer = await db.get(primaryKey);
  return UserNameProof.decode(new Uint8Array(buffer));
};

export const putUserNameProofTransaction = (txn: Transaction, usernameProof: UserNameProof): Transaction => {
  const proofBuffer = Buffer.from(UserNameProof.encode(usernameProof).finish());

  const primaryKey = makeFNameUserNameProofKey(usernameProof.name);
  const putTxn = txn.put(primaryKey, proofBuffer);

  return putTxn;
};

export const deleteUserNameProofTransaction = (txn: Transaction, usernameProof: UserNameProof): Transaction => {
  const primaryKey = makeFNameUserNameProofKey(usernameProof.name);
  const deleteTxn = txn.del(primaryKey);

  return deleteTxn;
};
