import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const suite = process.argv[2];
if (!['science', 'data', 'platform', 'state', 'object'].includes(suite)) throw new Error('明确指定 science/data/platform/state/object 测试族');
const names = (await readdir('tests')).filter(name => name.startsWith(suite) && name.endsWith('.test.ts')).sort();
if (!names.length) throw new Error(`${suite}: 尚无测试文件，禁止将零测试声明为通过`);
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...names.map(name => `tests/${name}`)], { stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
