/**
 * AWS (Assurance Workflow Skills) OpenCode plugin — packaged entrypoint.
 *
 * Registers synced `.opencode/skills/` (and legacy `skills/` when present) so
 * OpenCode discovers QA workflow skills without symlinks or manual config.
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  buildBootstrapContent,
  readPackageVersion,
  resolveSkillPaths,
} from './plugin-core';

interface OpenCodePluginClient {
  app: {
    log: (input: {
      body: {
        service: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
        extra?: Record<string, string>;
      };
    }) => Promise<void>;
  };
}

interface ChatMessagePart {
  type: string;
  text?: string;
}

interface ChatMessage {
  info: { role: string };
  parts: ChatMessagePart[];
}

interface OpenCodePluginContext {
  client: OpenCodePluginClient;
  directory?: string;
}

interface OpenCodeConfig {
  skills?: {
    paths?: string[];
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

let bootstrapCache: string | null | undefined;

function getBootstrapContent(skillPaths: string[]): string | null {
  if (bootstrapCache !== undefined) return bootstrapCache;
  bootstrapCache = buildBootstrapContent(skillPaths);
  return bootstrapCache;
}

async function emitLoadMarker(client: OpenCodePluginClient): Promise<void> {
  const version = readPackageVersion(PACKAGE_ROOT);
  try {
    await client.app.log({
      body: {
        service: 'assurance-workflow-skills',
        level: 'info',
        message: 'AWS_OPENCODE_PLUGIN_LOADED',
        extra: version ? { version } : undefined,
      },
    });
  } catch {
    // Logging must not block plugin registration.
  }
}

export default async function awsOpenCodePlugin({
  client,
  directory,
}: OpenCodePluginContext) {
  const skillPaths = resolveSkillPaths(__dirname, directory);
  await emitLoadMarker(client);

  return {
    config: async (config: OpenCodeConfig) => {
      config.skills = config.skills ?? {};
      config.skills.paths = config.skills.paths ?? [];
      for (const skillPath of skillPaths) {
        if (!config.skills.paths.includes(skillPath)) {
          config.skills.paths.push(skillPath);
        }
      }
    },

    'experimental.chat.messages.transform': async (
      _input: unknown,
      output: { messages: ChatMessage[] }
    ) => {
      const bootstrap = getBootstrapContent(skillPaths);
      if (!bootstrap || output.messages.length === 0) return;

      const firstUser = output.messages.find((m) => m.info.role === 'user');
      if (!firstUser || firstUser.parts.length === 0) return;

      if (
        firstUser.parts.some(
          (p) => p.type === 'text' && p.text?.includes('AWS (Assurance Workflow Skills)')
        )
      ) {
        return;
      }

      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: 'text', text: bootstrap });
    },
  };
}
