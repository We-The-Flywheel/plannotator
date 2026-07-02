import React from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { DiffOptionsPopover } from '../components/DiffOptionsPopover';

/**
 * Split/Unified diff toggle + options, pinned to the right of the dock tab strip
 * (dockview's `rightHeaderActionsComponent`). Stays visible while the tabs
 * scroll. Reads/writes the global `configStore`, so it needs no props/context.
 *
 * Rendered per group; for now it shows in every group's tab strip (the diff
 * setting is global). Scoping it to the diff-bearing group is a later refinement
 * if splitting proves it noisy.
 */
export const ReviewDockRightActions: React.FC<IDockviewHeaderActionsProps> = () => {
  const diffStyle = useConfigValue('diffStyle');
  return (
    <div className="flex items-center h-full pr-2 pl-1">
      <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
        <button
          onClick={() => configStore.set('diffStyle', 'split')}
          className={`px-2 py-1 text-xs rounded-md transition-colors ${
            diffStyle === 'split'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Split
        </button>
        <button
          onClick={() => configStore.set('diffStyle', 'unified')}
          className={`px-2 py-1 text-xs rounded-md transition-colors ${
            diffStyle === 'unified'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Unified
        </button>
        <div className="w-px h-4 bg-border/60 mx-0.5" />
        <DiffOptionsPopover />
      </div>
    </div>
  );
};
