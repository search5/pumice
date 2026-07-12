// Safely extracts a display message from a caught value without assuming it's an Error --
// catch bindings are `unknown` here, and grpc-web/fetch-adjacent code can reject with non-Error
// values (RpcError-shaped objects, strings, etc).
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
