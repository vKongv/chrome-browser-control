import { stopBrokerProcess } from '../broker-process.js';
import type { ParsedArgs } from '../parse-args.js';

export async function runStop(_args: ParsedArgs): Promise<number> {
  const result = await stopBrokerProcess();
  if (result === 'not_running') {
    console.log('Broker is not running.');
    return 0;
  }
  console.log('Stopped broker.');
  return 0;
}
