import * as jspb from 'google-protobuf'



export class Empty extends jspb.Message {
  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Empty.AsObject;
  static toObject(includeInstance: boolean, msg: Empty): Empty.AsObject;
  static serializeBinaryToWriter(message: Empty, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Empty;
  static deserializeBinaryFromReader(message: Empty, reader: jspb.BinaryReader): Empty;
}

export namespace Empty {
  export type AsObject = {
  }
}

export class Pong extends jspb.Message {
  getServerVersion(): string;
  setServerVersion(value: string): Pong;

  getTimestampMs(): number;
  setTimestampMs(value: number): Pong;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Pong.AsObject;
  static toObject(includeInstance: boolean, msg: Pong): Pong.AsObject;
  static serializeBinaryToWriter(message: Pong, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Pong;
  static deserializeBinaryFromReader(message: Pong, reader: jspb.BinaryReader): Pong;
}

export namespace Pong {
  export type AsObject = {
    serverVersion: string,
    timestampMs: number,
  }
}

export class FileMeta extends jspb.Message {
  getPath(): string;
  setPath(value: string): FileMeta;

  getModifiedAtMs(): number;
  setModifiedAtMs(value: number): FileMeta;

  getSizeBytes(): number;
  setSizeBytes(value: number): FileMeta;

  getContentHash(): string;
  setContentHash(value: string): FileMeta;

  getIsDeleted(): boolean;
  setIsDeleted(value: boolean): FileMeta;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): FileMeta.AsObject;
  static toObject(includeInstance: boolean, msg: FileMeta): FileMeta.AsObject;
  static serializeBinaryToWriter(message: FileMeta, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): FileMeta;
  static deserializeBinaryFromReader(message: FileMeta, reader: jspb.BinaryReader): FileMeta;
}

export namespace FileMeta {
  export type AsObject = {
    path: string,
    modifiedAtMs: number,
    sizeBytes: number,
    contentHash: string,
    isDeleted: boolean,
  }
}

export class DeltaRequest extends jspb.Message {
  getVaultId(): string;
  setVaultId(value: string): DeltaRequest;

  getLocalFilesList(): Array<FileMeta>;
  setLocalFilesList(value: Array<FileMeta>): DeltaRequest;
  clearLocalFilesList(): DeltaRequest;
  addLocalFiles(value?: FileMeta, index?: number): FileMeta;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DeltaRequest.AsObject;
  static toObject(includeInstance: boolean, msg: DeltaRequest): DeltaRequest.AsObject;
  static serializeBinaryToWriter(message: DeltaRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DeltaRequest;
  static deserializeBinaryFromReader(message: DeltaRequest, reader: jspb.BinaryReader): DeltaRequest;
}

export namespace DeltaRequest {
  export type AsObject = {
    vaultId: string,
    localFilesList: Array<FileMeta.AsObject>,
  }
}

export class DeltaResponse extends jspb.Message {
  getNeedUploadList(): Array<string>;
  setNeedUploadList(value: Array<string>): DeltaResponse;
  clearNeedUploadList(): DeltaResponse;
  addNeedUpload(value: string, index?: number): DeltaResponse;

  getNeedDownloadList(): Array<FileMeta>;
  setNeedDownloadList(value: Array<FileMeta>): DeltaResponse;
  clearNeedDownloadList(): DeltaResponse;
  addNeedDownload(value?: FileMeta, index?: number): FileMeta;

  getConflictsList(): Array<Conflict>;
  setConflictsList(value: Array<Conflict>): DeltaResponse;
  clearConflictsList(): DeltaResponse;
  addConflicts(value?: Conflict, index?: number): Conflict;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DeltaResponse.AsObject;
  static toObject(includeInstance: boolean, msg: DeltaResponse): DeltaResponse.AsObject;
  static serializeBinaryToWriter(message: DeltaResponse, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DeltaResponse;
  static deserializeBinaryFromReader(message: DeltaResponse, reader: jspb.BinaryReader): DeltaResponse;
}

export namespace DeltaResponse {
  export type AsObject = {
    needUploadList: Array<string>,
    needDownloadList: Array<FileMeta.AsObject>,
    conflictsList: Array<Conflict.AsObject>,
  }
}

export class Conflict extends jspb.Message {
  getServerVersion(): FileMeta | undefined;
  setServerVersion(value?: FileMeta): Conflict;
  hasServerVersion(): boolean;
  clearServerVersion(): Conflict;

  getClientVersion(): FileMeta | undefined;
  setClientVersion(value?: FileMeta): Conflict;
  hasClientVersion(): boolean;
  clearClientVersion(): Conflict;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Conflict.AsObject;
  static toObject(includeInstance: boolean, msg: Conflict): Conflict.AsObject;
  static serializeBinaryToWriter(message: Conflict, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Conflict;
  static deserializeBinaryFromReader(message: Conflict, reader: jspb.BinaryReader): Conflict;
}

export namespace Conflict {
  export type AsObject = {
    serverVersion?: FileMeta.AsObject,
    clientVersion?: FileMeta.AsObject,
  }
}

export class FileChunk extends jspb.Message {
  getHeader(): ChunkHeader | undefined;
  setHeader(value?: ChunkHeader): FileChunk;
  hasHeader(): boolean;
  clearHeader(): FileChunk;

  getData(): ChunkData | undefined;
  setData(value?: ChunkData): FileChunk;
  hasData(): boolean;
  clearData(): FileChunk;

  getEof(): ChunkEOF | undefined;
  setEof(value?: ChunkEOF): FileChunk;
  hasEof(): boolean;
  clearEof(): FileChunk;

  getPayloadCase(): FileChunk.PayloadCase;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): FileChunk.AsObject;
  static toObject(includeInstance: boolean, msg: FileChunk): FileChunk.AsObject;
  static serializeBinaryToWriter(message: FileChunk, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): FileChunk;
  static deserializeBinaryFromReader(message: FileChunk, reader: jspb.BinaryReader): FileChunk;
}

export namespace FileChunk {
  export type AsObject = {
    header?: ChunkHeader.AsObject,
    data?: ChunkData.AsObject,
    eof?: ChunkEOF.AsObject,
  }

  export enum PayloadCase { 
    PAYLOAD_NOT_SET = 0,
    HEADER = 1,
    DATA = 2,
    EOF = 3,
  }
}

export class ChunkHeader extends jspb.Message {
  getVaultId(): string;
  setVaultId(value: string): ChunkHeader;

  getPath(): string;
  setPath(value: string): ChunkHeader;

  getTotalBytes(): number;
  setTotalBytes(value: number): ChunkHeader;

  getModifiedAtMs(): number;
  setModifiedAtMs(value: number): ChunkHeader;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ChunkHeader.AsObject;
  static toObject(includeInstance: boolean, msg: ChunkHeader): ChunkHeader.AsObject;
  static serializeBinaryToWriter(message: ChunkHeader, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ChunkHeader;
  static deserializeBinaryFromReader(message: ChunkHeader, reader: jspb.BinaryReader): ChunkHeader;
}

export namespace ChunkHeader {
  export type AsObject = {
    vaultId: string,
    path: string,
    totalBytes: number,
    modifiedAtMs: number,
  }
}

export class ChunkData extends jspb.Message {
  getPath(): string;
  setPath(value: string): ChunkData;

  getSequence(): number;
  setSequence(value: number): ChunkData;

  getData(): Uint8Array | string;
  getData_asU8(): Uint8Array;
  getData_asB64(): string;
  setData(value: Uint8Array | string): ChunkData;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ChunkData.AsObject;
  static toObject(includeInstance: boolean, msg: ChunkData): ChunkData.AsObject;
  static serializeBinaryToWriter(message: ChunkData, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ChunkData;
  static deserializeBinaryFromReader(message: ChunkData, reader: jspb.BinaryReader): ChunkData;
}

export namespace ChunkData {
  export type AsObject = {
    path: string,
    sequence: number,
    data: Uint8Array | string,
  }
}

export class ChunkEOF extends jspb.Message {
  getPath(): string;
  setPath(value: string): ChunkEOF;

  getContentHash(): string;
  setContentHash(value: string): ChunkEOF;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ChunkEOF.AsObject;
  static toObject(includeInstance: boolean, msg: ChunkEOF): ChunkEOF.AsObject;
  static serializeBinaryToWriter(message: ChunkEOF, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ChunkEOF;
  static deserializeBinaryFromReader(message: ChunkEOF, reader: jspb.BinaryReader): ChunkEOF;
}

export namespace ChunkEOF {
  export type AsObject = {
    path: string,
    contentHash: string,
  }
}

export class UploadAck extends jspb.Message {
  getPath(): string;
  setPath(value: string): UploadAck;

  getOk(): boolean;
  setOk(value: boolean): UploadAck;

  getError(): string;
  setError(value: string): UploadAck;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): UploadAck.AsObject;
  static toObject(includeInstance: boolean, msg: UploadAck): UploadAck.AsObject;
  static serializeBinaryToWriter(message: UploadAck, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): UploadAck;
  static deserializeBinaryFromReader(message: UploadAck, reader: jspb.BinaryReader): UploadAck;
}

export namespace UploadAck {
  export type AsObject = {
    path: string,
    ok: boolean,
    error: string,
  }
}

export class UploadBatch extends jspb.Message {
  getChunksList(): Array<FileChunk>;
  setChunksList(value: Array<FileChunk>): UploadBatch;
  clearChunksList(): UploadBatch;
  addChunks(value?: FileChunk, index?: number): FileChunk;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): UploadBatch.AsObject;
  static toObject(includeInstance: boolean, msg: UploadBatch): UploadBatch.AsObject;
  static serializeBinaryToWriter(message: UploadBatch, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): UploadBatch;
  static deserializeBinaryFromReader(message: UploadBatch, reader: jspb.BinaryReader): UploadBatch;
}

export namespace UploadBatch {
  export type AsObject = {
    chunksList: Array<FileChunk.AsObject>,
  }
}

export class DownloadBatchRequest extends jspb.Message {
  getVaultId(): string;
  setVaultId(value: string): DownloadBatchRequest;

  getPathsList(): Array<string>;
  setPathsList(value: Array<string>): DownloadBatchRequest;
  clearPathsList(): DownloadBatchRequest;
  addPaths(value: string, index?: number): DownloadBatchRequest;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DownloadBatchRequest.AsObject;
  static toObject(includeInstance: boolean, msg: DownloadBatchRequest): DownloadBatchRequest.AsObject;
  static serializeBinaryToWriter(message: DownloadBatchRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DownloadBatchRequest;
  static deserializeBinaryFromReader(message: DownloadBatchRequest, reader: jspb.BinaryReader): DownloadBatchRequest;
}

export namespace DownloadBatchRequest {
  export type AsObject = {
    vaultId: string,
    pathsList: Array<string>,
  }
}

export class HistoryRequest extends jspb.Message {
  getVaultId(): string;
  setVaultId(value: string): HistoryRequest;

  getPath(): string;
  setPath(value: string): HistoryRequest;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): HistoryRequest.AsObject;
  static toObject(includeInstance: boolean, msg: HistoryRequest): HistoryRequest.AsObject;
  static serializeBinaryToWriter(message: HistoryRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): HistoryRequest;
  static deserializeBinaryFromReader(message: HistoryRequest, reader: jspb.BinaryReader): HistoryRequest;
}

export namespace HistoryRequest {
  export type AsObject = {
    vaultId: string,
    path: string,
  }
}

export class HistoryVersion extends jspb.Message {
  getHistoryId(): number;
  setHistoryId(value: number): HistoryVersion;

  getModifiedAtMs(): number;
  setModifiedAtMs(value: number): HistoryVersion;

  getSizeBytes(): number;
  setSizeBytes(value: number): HistoryVersion;

  getContentHash(): string;
  setContentHash(value: string): HistoryVersion;

  getDeviceName(): string;
  setDeviceName(value: string): HistoryVersion;

  getUserName(): string;
  setUserName(value: string): HistoryVersion;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): HistoryVersion.AsObject;
  static toObject(includeInstance: boolean, msg: HistoryVersion): HistoryVersion.AsObject;
  static serializeBinaryToWriter(message: HistoryVersion, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): HistoryVersion;
  static deserializeBinaryFromReader(message: HistoryVersion, reader: jspb.BinaryReader): HistoryVersion;
}

export namespace HistoryVersion {
  export type AsObject = {
    historyId: number,
    modifiedAtMs: number,
    sizeBytes: number,
    contentHash: string,
    deviceName: string,
    userName: string,
  }
}

export class HistoryResponse extends jspb.Message {
  getVersionsList(): Array<HistoryVersion>;
  setVersionsList(value: Array<HistoryVersion>): HistoryResponse;
  clearVersionsList(): HistoryResponse;
  addVersions(value?: HistoryVersion, index?: number): HistoryVersion;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): HistoryResponse.AsObject;
  static toObject(includeInstance: boolean, msg: HistoryResponse): HistoryResponse.AsObject;
  static serializeBinaryToWriter(message: HistoryResponse, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): HistoryResponse;
  static deserializeBinaryFromReader(message: HistoryResponse, reader: jspb.BinaryReader): HistoryResponse;
}

export namespace HistoryResponse {
  export type AsObject = {
    versionsList: Array<HistoryVersion.AsObject>,
  }
}

export class HistoryVersionDownloadRequest extends jspb.Message {
  getVaultId(): string;
  setVaultId(value: string): HistoryVersionDownloadRequest;

  getPath(): string;
  setPath(value: string): HistoryVersionDownloadRequest;

  getHistoryId(): number;
  setHistoryId(value: number): HistoryVersionDownloadRequest;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): HistoryVersionDownloadRequest.AsObject;
  static toObject(includeInstance: boolean, msg: HistoryVersionDownloadRequest): HistoryVersionDownloadRequest.AsObject;
  static serializeBinaryToWriter(message: HistoryVersionDownloadRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): HistoryVersionDownloadRequest;
  static deserializeBinaryFromReader(message: HistoryVersionDownloadRequest, reader: jspb.BinaryReader): HistoryVersionDownloadRequest;
}

export namespace HistoryVersionDownloadRequest {
  export type AsObject = {
    vaultId: string,
    path: string,
    historyId: number,
  }
}

export class RestoreHistoryRequest extends jspb.Message {
  getVaultId(): string;
  setVaultId(value: string): RestoreHistoryRequest;

  getPath(): string;
  setPath(value: string): RestoreHistoryRequest;

  getHistoryId(): number;
  setHistoryId(value: number): RestoreHistoryRequest;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): RestoreHistoryRequest.AsObject;
  static toObject(includeInstance: boolean, msg: RestoreHistoryRequest): RestoreHistoryRequest.AsObject;
  static serializeBinaryToWriter(message: RestoreHistoryRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): RestoreHistoryRequest;
  static deserializeBinaryFromReader(message: RestoreHistoryRequest, reader: jspb.BinaryReader): RestoreHistoryRequest;
}

export namespace RestoreHistoryRequest {
  export type AsObject = {
    vaultId: string,
    path: string,
    historyId: number,
  }
}

export class RestoreHistoryResponse extends jspb.Message {
  getOk(): boolean;
  setOk(value: boolean): RestoreHistoryResponse;

  getError(): string;
  setError(value: string): RestoreHistoryResponse;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): RestoreHistoryResponse.AsObject;
  static toObject(includeInstance: boolean, msg: RestoreHistoryResponse): RestoreHistoryResponse.AsObject;
  static serializeBinaryToWriter(message: RestoreHistoryResponse, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): RestoreHistoryResponse;
  static deserializeBinaryFromReader(message: RestoreHistoryResponse, reader: jspb.BinaryReader): RestoreHistoryResponse;
}

export namespace RestoreHistoryResponse {
  export type AsObject = {
    ok: boolean,
    error: string,
  }
}

