import { $, spawn } from 'bun';
import { extract } from 'tar-stream';
import { log } from './logger';

export const CONTAINER_HOME = '/home/hermes';

export async function writeFileToContainer(
  containerId: string,
  containerPath: string,
  content: string,
): Promise<void> {
  const escaped = $.escape(containerPath);
  const proc = spawn(
    [
      'docker',
      'exec',
      '-i',
      containerId,
      'sh',
      '-c',
      `mkdir -p $(dirname ${escaped}) && cat > ${escaped}`,
    ],
    { stdin: new Blob([content]), stderr: 'pipe', stdout: 'pipe' },
  );
  const code = await proc.exited;
  if (code) {
    log.error(
      {
        code,
        containerId,
        containerPath,
        stdout: await proc.stdout.text(),
        stderr: await proc.stderr.text(),
      },
      'Failed to write file to container',
    );
    throw new Error(`Failed to write file to container: ${code}`);
  } else {
    log.trace({ containerId, containerPath }, 'writeFileToContainer');
  }
}

export async function readFileFromContainer(
  containerId: string,
  containerPath: string,
): Promise<string> {
  const proc = spawn(['docker', 'cp', `${containerId}:${containerPath}`, '-'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const ex = extract();

  const result = new Promise<string>((resolve, reject) => {
    let resolved = false;
    ex.on('entry', (_header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
        resolved = true;
        next();
      });
    });
    ex.on('error', reject);
    ex.on('finish', () => {
      if (!resolved) {
        reject(new Error('File not found in container'));
      }
    });
  });

  await proc.stdout.pipeTo(
    new WritableStream({
      write(chunk) {
        ex.write(chunk);
      },
      close() {
        ex.end();
      },
    }),
  );

  return result;
}
