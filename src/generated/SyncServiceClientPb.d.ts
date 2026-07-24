/**
 * @fileoverview gRPC-Web generated client stub for obsidian.sync.v1
 * @enhanceable
 * @public
 */
import * as grpcWeb from 'grpc-web';
import * as sync_pb from './sync_pb';
export declare class SyncServiceClient {
    client_: grpcWeb.AbstractClientBase;
    hostname_: string;
    credentials_: null | {
        [index: string]: string;
    };
    options_: null | {
        [index: string]: any;
    };
    constructor(hostname: string, credentials?: null | {
        [index: string]: string;
    }, options?: null | {
        [index: string]: any;
    });
    methodDescriptorPing: grpcWeb.MethodDescriptor<sync_pb.Empty, sync_pb.Pong>;
    ping(request: sync_pb.Empty, metadata?: grpcWeb.Metadata | null): Promise<sync_pb.Pong>;
    ping(request: sync_pb.Empty, metadata: grpcWeb.Metadata | null, callback: (err: grpcWeb.RpcError, response: sync_pb.Pong) => void): grpcWeb.ClientReadableStream<sync_pb.Pong>;
    methodDescriptorDelta: grpcWeb.MethodDescriptor<sync_pb.DeltaRequest, sync_pb.DeltaResponse>;
    delta(request: sync_pb.DeltaRequest, metadata?: grpcWeb.Metadata | null): Promise<sync_pb.DeltaResponse>;
    delta(request: sync_pb.DeltaRequest, metadata: grpcWeb.Metadata | null, callback: (err: grpcWeb.RpcError, response: sync_pb.DeltaResponse) => void): grpcWeb.ClientReadableStream<sync_pb.DeltaResponse>;
    methodDescriptorUploadFiles: grpcWeb.MethodDescriptor<sync_pb.UploadBatch, sync_pb.UploadAck>;
    uploadFiles(request: sync_pb.UploadBatch, metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<sync_pb.UploadAck>;
    methodDescriptorDownloadFiles: grpcWeb.MethodDescriptor<sync_pb.DownloadBatchRequest, sync_pb.FileChunk>;
    downloadFiles(request: sync_pb.DownloadBatchRequest, metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<sync_pb.FileChunk>;
    methodDescriptorGetFileHistory: grpcWeb.MethodDescriptor<sync_pb.HistoryRequest, sync_pb.HistoryResponse>;
    getFileHistory(request: sync_pb.HistoryRequest, metadata?: grpcWeb.Metadata | null): Promise<sync_pb.HistoryResponse>;
    getFileHistory(request: sync_pb.HistoryRequest, metadata: grpcWeb.Metadata | null, callback: (err: grpcWeb.RpcError, response: sync_pb.HistoryResponse) => void): grpcWeb.ClientReadableStream<sync_pb.HistoryResponse>;
    methodDescriptorDownloadHistoryVersion: grpcWeb.MethodDescriptor<sync_pb.HistoryVersionDownloadRequest, sync_pb.FileChunk>;
    downloadHistoryVersion(request: sync_pb.HistoryVersionDownloadRequest, metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<sync_pb.FileChunk>;
    methodDescriptorRestoreHistoryVersion: grpcWeb.MethodDescriptor<sync_pb.RestoreHistoryRequest, sync_pb.RestoreHistoryResponse>;
    restoreHistoryVersion(request: sync_pb.RestoreHistoryRequest, metadata?: grpcWeb.Metadata | null): Promise<sync_pb.RestoreHistoryResponse>;
    restoreHistoryVersion(request: sync_pb.RestoreHistoryRequest, metadata: grpcWeb.Metadata | null, callback: (err: grpcWeb.RpcError, response: sync_pb.RestoreHistoryResponse) => void): grpcWeb.ClientReadableStream<sync_pb.RestoreHistoryResponse>;
}
