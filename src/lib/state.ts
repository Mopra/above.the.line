import { get, put } from '@vercel/blob';
import { config } from './config';
import { initialState, type BotState } from './types';

function statePath(): string {
  return `${config.statePrefix}/state.json`;
}

/**
 * Two ways a deployment can reach the store. The classic one is a read-write
 * token. The one `vercel blob create-store` wires up now is OIDC: connecting a
 * store sets BLOB_STORE_ID, and Vercel injects VERCEL_OIDC_TOKEN at runtime to
 * authenticate against it. The SDK picks up whichever is present, so either
 * counts as having durable storage.
 */
function hasBlobStore(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
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

/**
 * On Vercel the filesystem is read-only apart from /tmp, so the local fallback
 * cannot work there: it fails with an unhelpful EROFS deep inside a write. Say
 * plainly what is wrong instead, because a run that cannot save its state has
 * not really happened — it would re-decide the same signal tomorrow with no
 * memory of the position it just took.
 */
function requireDurableStorage(): void {
  if (process.env.VERCEL && !hasBlobStore()) {
    throw new Error(
      'No Blob store reachable from this deployment (neither BLOB_STORE_ID nor ' +
        'BLOB_READ_WRITE_TOKEN is set), so there is nowhere durable to save ' +
        'state. Connect a Vercel Blob store to the project (Storage tab > ' +
        'Connect Project), then redeploy. Refusing to trade without memory.',
    );
  }
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

/**
 * Keep a frozen copy of a ledger under its own key. Used when the bot switches
 * between paper and live: the old run must not be blended into the new one, but
 * it is the only record of how the strategy actually behaved, so throwing it
 * away would waste the whole point of paper trading.
 */
export async function archiveState(state: BotState, label: string): Promise<string> {
  const body = JSON.stringify(state, null, 2);
  if (!hasBlobStore()) {
    const path = `.bot-state-${label}.json`;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, body, 'utf8');
    return path;
  }
  const path = `${config.statePrefix}/archive/${label}.json`;
  await put(path, body, {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    addRandomSuffix: false,
  });
  return path;
}

export async function saveState(state: BotState): Promise<void> {
  requireDurableStorage();
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
