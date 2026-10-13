// Types for worker.js, for the tracker's tests (src/mail.test.ts) only.
export interface EmailMessageLike {
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}
declare const worker: {
  readonly MAX_MAIL_BYTES: number;
  refusal(status: number): string;
  email(message: EmailMessageLike, env: Record<string, string | undefined>): Promise<void>;
};
export default worker;
