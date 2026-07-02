import React, { useState } from 'react';
import { TextShimmer } from './TextShimmer';
import type { UpdateInfo } from '../hooks/useUpdateCheck';
import type { Origin } from '@plannotator/shared/agents';
import { isWindows } from '../utils/platform';

// Build metadata injected by the app vite configs (apps/hook, apps/review).
// May be absent in builds that don't define them (e.g. portal) — always
// guarded with `typeof` checks before use.
declare const __GIT_BRANCH__: string;
declare const __GIT_COMMIT__: string;
declare const __CUSTOM_BUILD__: boolean;

const PI_INSTALL_COMMAND = 'pi install npm:@plannotator/pi-extension';

function getInstallCommand(origin?: Origin | null, isWSL = false): string {
  if (origin === 'pi') return PI_INSTALL_COMMAND;
  return isWindows && !isWSL
    ? 'powershell -c "irm https://plannotator.ai/install.ps1 | iex"'
    : 'curl -fsSL https://plannotator.ai/install.sh | bash';
}

interface MenuVersionSectionProps {
  appVersion: string;
  updateInfo?: UpdateInfo | null;
  origin?: Origin | null;
  isWSL: boolean;
  closeMenu: () => void;
}

export const MenuVersionSection: React.FC<MenuVersionSectionProps> = ({
  appVersion,
  updateInfo,
  origin,
  isWSL,
  closeMenu,
}) => {
  const [copied, setCopied] = useState(false);
  const hasUpdate = !!updateInfo?.updateAvailable;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getInstallCommand(origin, isWSL));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  return (
    <div className="px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <a
          href="https://github.com/backnotprop/plannotator"
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          className="text-[10px] font-semibold tracking-wide text-muted-foreground hover:text-foreground transition-colors"
        >
          Plannotator
        </a>
        <span
          className="text-[10px] font-mono text-muted-foreground/70"
          title={typeof __GIT_COMMIT__ !== 'undefined' ? `${typeof __GIT_BRANCH__ !== 'undefined' ? __GIT_BRANCH__ : ''}@${__GIT_COMMIT__}` : undefined}
        >
          v{appVersion}
          {typeof __GIT_COMMIT__ !== 'undefined' && (
            <span className="opacity-50 ml-0.5">({typeof __GIT_BRANCH__ !== 'undefined' ? __GIT_BRANCH__ : ''}@{__GIT_COMMIT__})</span>
          )}
          {typeof __CUSTOM_BUILD__ !== 'undefined' && __CUSTOM_BUILD__ && (
            <span className="px-1.5 py-0.5 rounded font-medium ml-1.5 bg-amber-500/15 text-amber-500">
              Custom Build
            </span>
          )}
        </span>
      </div>
      <div className="flex flex-col items-start gap-1 text-[11px]">
        <span className="flex items-center gap-1.5">
          <a
            href={hasUpdate ? updateInfo!.releaseUrl : 'https://github.com/backnotprop/plannotator/releases'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeMenu}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Release notes
          </a>
          {hasUpdate && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <TextShimmer className="text-[10px] font-medium" duration={2.5} spread={1.5}>
                New update available!
              </TextShimmer>
            </>
          )}
        </span>
        {hasUpdate && (
          <button
            onClick={handleCopy}
            className="w-full mt-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {copied ? 'Copied!' : 'Copy update command'}
          </button>
        )}
      </div>
    </div>
  );
};
