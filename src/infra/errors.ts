export class BuoyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BuoyError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// oxlint-disable-next-line no-control-regex -- Remove terminal control bytes from diagnostic output.
const terminalControlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitize(text: string): string {
  return text
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|access_token|auth|key|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(terminalControlCharacters, '');
}
