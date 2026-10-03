import type { Server } from 'node:http';

export interface MockRequest {
  kind: 'token' | 'api';
  method: string;
  path: string;
  query?: Record<string, string>;
  context?: string | null;
  clientId?: string | null;
  tool?: string;
}

export function createMockAppleApi(): {
  server: Server;
  requests: MockRequest[];
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
};
