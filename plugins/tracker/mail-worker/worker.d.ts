// Types for worker.js, for the tracker's tests (src/mail-worker.test.ts) only.
export declare const MAX_MAIL_BYTES: number;
export declare function refusal(status: number): string;
export interface EmailMessageLike {
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}
declare const worker: {
  email(message: EmailMessageLike, env: Record<string, string | undefined>): Promise<void>;
};
export default worker;
