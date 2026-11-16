import { pathToFileURL } from 'node:url';
import { buildHost, hostBuildSource } from './build-host.js';

export const controlBuildSource = hostBuildSource;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildHost(process.argv[2]);
