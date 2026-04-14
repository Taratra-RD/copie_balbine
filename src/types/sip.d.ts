declare module 'sip' {
  export interface SipMessage {
    method?: string;
    status?: number;
    headers?: Record<string, any>;
    uri?: any;
    content?: string;
  }
  export interface SipStack {
    send(msg: any): void;
    on(event: string, cb: (msg: any) => void): void;
    close(): void;
  }
  export function start(options: { protocol: string; address: string; port: number }, handler: (req: any) => void): SipStack;
  export function makeResponse(req: any, code: number, reason?: string, options?: { headers?: any; content?: string }): any;
}
