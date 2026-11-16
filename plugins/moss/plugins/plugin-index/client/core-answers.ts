// What the core answers the Plugins page's calls (the core's own results, written out here: a part types its answers
// itself, F2b; the SDK's `CoreClient` is untyped). Kept by hand; the core's schemas are the source.
import type { CoreClient } from "@waifucave/moss-plugin-sdk/ui";

export interface CoreAnswers {
  "plugin.get": {
    plugin: {
      id: string;
      parent?: string;
      name: string | {
        en: string;
        [key: string]: string;
      };
      description?: string | {
        en: string;
        [key: string]: string;
      };
      icon?: string;
      version: string;
      state: "found" | "refused" | "invalid" | "off" | "waiting" | "running" | "stopped";
      reason?: string;
      waitingFor?: string[];
      enabled: boolean;
      source: "bundled" | "index" | "npm" | "local" | "wrapped" | "dev";
      class: "data" | "web" | "code";
      treeHash?: string;
      namespace: string;
      scope: ("bots" | "agents" | "both") | "own-bot";
      adult: boolean;
      children: string[];
      labels?: string[];
      dev: boolean;
      parts?: {
        app: {
          enabled: boolean;
          has: string[];
          bot?: string;
        };
      };
      manifest: {
        [key: string]: unknown;
      };
      provenance: {
        by: "user-app" | "user-terminal" | "bot" | "migration" | "found" | "bundled" | "plugin";
        at: number;
        bot?: string;
        plugin?: string;
        wrapped?: {
          from: "mcp-config" | "mcp-url" | "skill-folder" | "agent-file" | "claude-plugin";
          unused?: string[];
          network?: "any";
          reads?: string[];
          unreadable?: string[];
        };
        index?: {
          url: string;
          version: string;
        };
        npm?: {
          name: string;
          version: string;
        };
      };
      capabilities: string[];
      networkHosts: string[];
      helperPermissions: string[];
      issues: {
        severity: "error" | "warning";
        refuses: "plugin" | "contribution" | "entry" | "none";
        code: string;
        message: string;
        file: string;
        path: string;
      }[];
      logTail: string[];
      computers?: {
        [key: string]: string[];
      };
      pinned: boolean;
    };
  };
  "plugin.list": {
    plugins: {
      id: string;
      parent?: string;
      name: string | {
        en: string;
        [key: string]: string;
      };
      description?: string | {
        en: string;
        [key: string]: string;
      };
      icon?: string;
      version: string;
      state: "found" | "refused" | "invalid" | "off" | "waiting" | "running" | "stopped";
      reason?: string;
      waitingFor?: string[];
      enabled: boolean;
      source: "bundled" | "index" | "npm" | "local" | "wrapped" | "dev";
      class: "data" | "web" | "code";
      treeHash?: string;
      namespace: string;
      scope: ("bots" | "agents" | "both") | "own-bot";
      adult: boolean;
      children: string[];
      labels?: string[];
      dev: boolean;
      parts?: {
        app: {
          enabled: boolean;
          has: string[];
          bot?: string;
        };
      };
    }[];
    adultConfirmed?: boolean;
  };
  "plugin.ui": {
    plugins: {
      pluginId: string;
      name: string | {
        en: string;
        [key: string]: string;
      };
      treeHash: string;
      source?: "bundled" | "index" | "npm" | "local" | "wrapped" | "dev";
      enabledAt?: number;
      capabilities?: string[];
      css?: string[];
      networkHosts?: string[];
      bot?: {
        name: string | {
          en: string;
          [key: string]: string;
        };
        theme?: string;
        layout?: string;
        userLayout?: string;
        avatar?: {
          file: string;
          format: string;
        };
      };
      avatarFormats?: {
        format: string;
        extensions: string[];
        kinds: {
          ext: string[];
          type: "json" | "binary" | "image" | "audio" | "text";
          maxBytes: number;
        }[];
        find: "folder" | "cubism-model3";
        maxFiles?: number;
      }[];
      layer: string;
      icon?: string;
      assetBase: string;
      clientEntry?: string;
      isolated?: true;
      clientBuild?: {
        base: string;
        file: string;
        sha256: string;
      };
      ui: {
        [key: string]: unknown;
      }[];
      themes: {
        id: string;
        file: string;
      }[];
      locales: {
        lang: string;
        file: string;
      }[];
      bots: "all" | string[];
    }[];
  };
  "plugin.settings.get": {
    settings: {
      key: string;
      type: "string" | "number" | "boolean" | "enum" | "color" | "secret";
      title: string | {
        en: string;
        [key: string]: string;
      };
      description?: string | {
        en: string;
        [key: string]: string;
      };
      scope: "account" | "device" | "bot";
      required: boolean;
      options?: (string | {
        value: string;
        title: string | {
          en: string;
          [key: string]: string;
        };
      })[];
      min?: number;
      max?: number;
      value?: unknown;
      set: boolean;
      defaultPending?: boolean;
      asks?: true;
    }[];
  };
  "plugin.auth.list": {
    auth: {
      index: number;
      method: "api-key" | "oauth-pkce" | "custom" | "core";
      secret?: string;
      state: "signed-out" | "signed-in" | "expired" | "refreshing" | "failed";
      account?: string;
      reason?: string;
    }[];
  };
  "plugin.logs": {
    lines: string[];
  };
  "notify.mutes": {
    muted: string[];
  };
  "plugin.grant.list": {
    grants: {
      token: string;
      path: string;
      kind: "file" | "folder";
      access: "read" | "write";
      addedAt: number;
    }[];
  };
  "command.list": {
    commands: {
      name: string;
      pluginId: string;
      description: string | {
        en: string;
        [key: string]: string;
      };
      args?: {
        [key: string]: unknown;
      };
      key?: string;
      keyState?: {
        state: "bound";
        chord: string;
      } | {
        state: "app";
        what: string;
      } | {
        state: "bare";
      } | {
        state: "clash";
        with: string[];
      };
      runsOn?: "each" | "main" | "chosen";
    }[];
  };
  "plugin.dev.list": {
    folders: {
      path: string;
      pluginId?: string;
      addedAt: number;
      expiresAt: number;
      lastReloadAt?: number;
    }[];
  };
  "plugin.update": {
    updated: {
      id: string;
      from: string;
      to: string;
    }[];
    offered?: {
      id: string;
      from: string;
      to: string;
      why: string;
    }[];
    failed?: {
      id: string;
      from: string;
      to: string;
      why: string;
    }[];
  };
  "plugin.index.list": {
    indexes: {
      url: string;
      name?: string;
      lastCheckedAt?: number;
      error?: string;
    }[];
  };
  "plugin.index.search": {
    entries: {
      id: string;
      index: string;
      name?: string | {
        en: string;
        [key: string]: string;
      };
      description?: string | {
        en: string;
        [key: string]: string;
      };
      versions: {
        version: string;
        hash: string;
      }[];
      installed?: string;
      adult?: boolean;
    }[];
  };
  "plugin.install": {
    id: string;
    state: "found" | "refused" | "invalid" | "off" | "waiting" | "running" | "stopped";
    treeHash?: string;
    card?: string;
    more?: {
      id: string;
      state: "found" | "refused" | "invalid" | "off" | "waiting" | "running" | "stopped";
      treeHash?: string;
      card?: string;
    }[];
  };
  "plugin.remove": {
    ok: true;
  } | {
    applied: false;
    card: string;
  };
  "plugin.setEnabled": {
    applied: true;
  } | {
    applied: false;
    card: string;
  };
  "plugin.pin": {
    applied: true;
  } | {
    applied: false;
    card: string;
  };
  "plugin.restart": {
    ok: true;
  };
  "plugin.settings.set": {
    applied: true;
  } | {
    applied: false;
    card: string;
  };
  "plugin.auth.signIn": {
    state: "signed-out" | "signed-in" | "expired" | "refreshing" | "failed";
    authorizeUrl?: string;
  };
  "plugin.auth.signOut": {
    ok: true;
  } | {
    applied: false;
    card: string;
  };
  "plugin.index.add": {
    applied: true;
  } | {
    applied: false;
    card: string;
  };
  "plugin.index.remove": {
    ok: true;
  } | {
    applied: false;
    card: string;
  };
  "plugin.dev.add": {
    applied: true;
  } | {
    applied: false;
    card: string;
  };
  "plugin.dev.remove": {
    ok: true;
  };
  "plugin.dev.renew": {
    expiresAt: number;
  } | {
    applied: false;
    card: string;
  };
  "plugin.grant.remove": {
    removed: boolean;
  };
  "plugin.confirmAdult": {
    ok: true;
  } | {
    applied: false;
    card: string;
  };
  "notify.setMuted": {
    ok: true;
  };
}

/** A core client whose calls this page knows answer as `CoreAnswers` says. */
export interface TypedCore {
  call<M extends keyof CoreAnswers>(method: M, params?: unknown): Promise<CoreAnswers[M]>;
  call(method: string, params?: unknown): Promise<any>;
  on: CoreClient["on"];
}

/** The part's core client, typed by its answers. */
export function typedCore(core: CoreClient | undefined): TypedCore | undefined {
  return core as TypedCore | undefined;
}
