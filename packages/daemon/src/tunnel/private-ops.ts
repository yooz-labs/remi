import type { OpenAt } from './admission';

export type PrivateOps = {
  openAt: OpenAt;
  create: (directory: number, name: string, flags: number, mode: number) => number;
  link: (directory: number, from: string, to: string) => number;
  unlink: (directory: number, name: string) => number;
};
