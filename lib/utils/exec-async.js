import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

/** Promise 版 exec */
export const exec = promisify(execCb);
