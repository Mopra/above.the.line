import { get, put } from '@vercel/blob';
import { config } from './config';
import { initialState, type BotState } from './types';

function statePath(): string {
  return `${config.statePrefix}/state.json`;
}

function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/**
 * Where state lives when there is no blob store: a plain JSON file. This is what
 * makes `npm run dev` useful — a local paper-trading run keeps its position and
 * history between runs without any cloud storage. On Vercel the filesystem is
 * ephemeral, so production must use Vercel Blob.
 */
function localFile(): string {
  return process.env.STATE_FILE ?? '.bot-state.json';
}

async function readLocal(): Promise<BotState | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(localFile(), 'utf8');
    return { ...initialState(), ...(JSON.parse(text) as Partial<BotState>) };
  } catch {
    return null;
  }
}

async function writeLocal(state: BotState): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(localFile(), JSON.stringify(state, null, 2), 'utf8');
}

export async function loadState(): Promise<BotState> {
  if (!hasBlobStore()) {
    return (await readLocal()) ?? initialState();
  }
  try {
    const result = await get(statePath(), { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return initialState();
    const text = await new Response(result.stream).text();
    const parsed = JSON.parse(text) as Partial<BotState>;
    // Merge over a fresh state so a field added in a later version cannot
    // crash a read of an older stored object.
    return { ...initialState(), ...parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not.?found|404|no such/i.test(message)) return initialState();
    throw err;
  }
}

export async function saveState(state: BotState): Promise<void> {
  if (!hasBlobStore()) {
    await writeLocal(state);
    return;
  }
  await put(statePath(), JSON.stringify(state, null, 2), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    addRandomSuffix: false,
  });
}
