// Page table of contents (2026-10-30).
//
// One outline per chapter. The chapter spine renders the routes; the Contents
// card renders these trees. Items are sections and nested groups only — never
// individual settings. Depth-0 sections remain collapsible cards on the page;
// every nested item is rendered as a non-collapsible group by sectionCards().
//
// `open` lists the section-card state keys that must be open before a nested
// anchor exists. Only depth-0 cards collapse now, so those chains are short.
import type { Route } from './navigation';
import type { StreamFrameConfig } from './types';

export interface OutlineContext {
  vendor: boolean;
  advancedMode: boolean;
  enhancements: boolean;
  controllerBypass: boolean;
  kalmanMode: boolean;
  gameLinkLayout: boolean;
  hasControllerSettings: boolean;
  settings?: StreamFrameConfig;
}

export interface OutlineItem {
  /** Anchor under section- (section IDs are prefixed by the page renderer). */
  id: string;
  /** Existing page heading source string; translated by the navigator. */
  label: string;
  children?: readonly OutlineItem[];
  /** Hide the row when the page does not render this section in this mode. */
  when?: (ctx: OutlineContext) => boolean;
  /** Section-card keys to open before scrollIntoView can find the anchor. */
  open?: readonly string[];
}

export interface ChapterView {
  route: Route;
  label: string;
  outline: OutlineItem[];
  /** Small dot on the About chapter when an update is available. */
  badge?: boolean;
}

const hasSettings = (ctx: OutlineContext): boolean => !!ctx.settings;
const vendorHasSettings = (ctx: OutlineContext): boolean => ctx.vendor && !!ctx.settings;

export const CHAPTER_OUTLINES: Record<Route, readonly OutlineItem[]> = {
  'driver-settings': [
    { id: 'headset', label: 'Headset', when: hasSettings, open: ['headset'] },
    {
      id: 'controllers', label: 'Controllers', when: hasSettings, open: ['controllers'],
      children: [
        {
          id: 'controller-fix', label: 'Controller Fix',
          when: ctx => !ctx.controllerBypass,
          open: ['controllers'],
          children: [
            {
              id: 'kalman-advanced', label: 'Kalman Advanced Settings',
              when: ctx => !ctx.controllerBypass && ctx.advancedMode && ctx.kalmanMode,
              open: ['controllers'],
            },
          ],
        },
        {
          id: 'game-link-layout', label: 'Game Link Layout',
          when: ctx => !ctx.controllerBypass && ctx.vendor,
          open: ['controllers'],
          children: [
            {
              id: 'game-link-offsets', label: 'Game Link Layout Offsets',
              when: ctx => !ctx.controllerBypass && ctx.vendor && ctx.gameLinkLayout,
              open: ['controllers'],
            },
          ],
        },
        {
          id: 'controllers-advanced', label: 'Controllers Advanced',
          when: ctx => !ctx.controllerBypass && ctx.advancedMode,
          open: ['controllers'],
          children: [
            {
              id: 'controller-offsets', label: 'Controller Offsets',
              when: ctx => !ctx.controllerBypass && ctx.advancedMode && ctx.hasControllerSettings,
              open: ['controllers'],
            },
            {
              id: 'pointer-tip-offset', label: 'Pointer Tip Offset',
              when: ctx => !ctx.controllerBypass && ctx.advancedMode && ctx.vendor && ctx.hasControllerSettings,
              open: ['controllers'],
            },
          ],
        },
      ],
    },
  ],

  'stream-frame': [
    { id: 'stream-quality', label: 'Stream Quality', when: vendorHasSettings, open: ['heading:stream-quality'] },
    {
      id: 'image-processing', label: 'Image Processing',
      when: hasSettings, open: ['heading:image-processing'],
      children: [
        { id: 'color', label: 'Color', when: ctx => ctx.enhancements, open: ['heading:image-processing'] },
        { id: 'image-enhancements', label: 'Image Enhancements', when: ctx => ctx.enhancements, open: ['heading:image-processing'] },
      ],
    },
    {
      id: 'optical-flow', label: 'Optical Flow',
      when: vendorHasSettings, open: ['heading:optical-flow'],
      children: [
        { id: 'advanced', label: 'Advanced', when: ctx => ctx.advancedMode, open: ['heading:optical-flow'] },
      ],
    },
    {
      id: 'encoder', label: 'Encoder Advanced',
      when: ctx => ctx.vendor && ctx.advancedMode && !!ctx.settings?.nvencTap,
      open: ['heading:encoder'],
    },
    {
      id: 'graveyard', label: 'Graveyard (retired experiments)',
      when: ctx => !!ctx.settings?.graveyardEnable,
      open: ['graveyard'],
    },
  ],

  debug: [
    {
      id: 'debug-monitoring', label: 'Monitoring', when: hasSettings,
      open: ['heading:debug-monitoring'],
      children: [{ id: 'debug-bitrate', label: 'Bitrate monitor', open: ['heading:debug-monitoring'] }],
    },
    {
      id: 'debug-image', label: 'Image Processing', when: hasSettings,
      open: ['heading:debug-image'],
      children: [{ id: 'debug-image-diagnostics', label: 'Diagnostics', open: ['heading:debug-image'] }],
    },
    {
      id: 'debug-controllers', label: 'Controllers', when: hasSettings,
      open: ['heading:debug-controllers'],
      children: [{ id: 'debug-controller-diagnostics', label: 'Diagnostics', open: ['heading:debug-controllers'] }],
    },
    {
      id: 'debug-encoder', label: 'Encoder',
      when: ctx => hasSettings(ctx) && ctx.vendor && !!ctx.settings?.nvencTap,
      open: ['heading:debug-encoder'],
      children: [{ id: 'debug-encoder-diagnostics', label: 'Diagnostics', open: ['heading:debug-encoder'] }],
    },
  ],

  'distortion-profile': [
    {
      id: 'distortion', label: 'Distortion Correction',
      when: ctx => hasSettings(ctx) && ctx.enhancements,
      open: ['distortion'],
      children: [
        {
          id: 'eye-align', label: 'Eye Alignment',
          when: ctx => ctx.enhancements && ctx.advancedMode,
          open: ['distortion'],
        },
      ],
    },
    {
      id: 'share', label: 'Share Distortion Profile',
      when: ctx => hasSettings(ctx) && ctx.enhancements,
      open: ['share'],
    },
  ],

  'app-settings': [
    { id: 'app-appearance', label: 'Appearance', open: ['heading:app-appearance'] },
    { id: 'app-window', label: 'Window', open: ['heading:app-window'] },
    { id: 'app-picture', label: 'Picture', open: ['heading:app-picture'] },
    { id: 'app-updates', label: 'Updates', open: ['heading:app-updates'] },
    {
      id: 'app-advanced', label: 'Advanced', open: ['heading:app-advanced'],
      children: [
        { id: 'app-update-install', label: 'Update install', open: ['heading:app-advanced'] },
      ],
    },
  ],

  setup: [
    { id: 'setup-headset', label: 'Set up your headset', open: ['heading:setup-headset'] },
    { id: 'setup-advanced', label: 'Advanced', open: ['heading:setup-advanced'] },
    { id: 'setup-check', label: 'Settings check', open: ['heading:setup-check'] },
    { id: 'setup-restore', label: 'Restore or remove', open: ['heading:setup-restore'] },
  ],

  about: [
    { id: 'about-version', label: 'Version and updates', open: ['heading:about-version'] },
    { id: 'about-links', label: 'Links', open: ['heading:about-links'] },
    { id: 'about-credits', label: 'Credits', open: ['heading:about-credits'] },
  ],
};

/** Filter the tree against the live mode and drop empty child lists. */
export function visibleOutline(items: readonly OutlineItem[], ctx: OutlineContext): OutlineItem[] {
  const visible: OutlineItem[] = [];
  for (const item of items) {
    if (item.when && !item.when(ctx)) continue;
    const children = item.children ? visibleOutline(item.children, ctx) : undefined;
    visible.push(children && children.length ? { ...item, children } : { ...item, children: undefined });
  }
  return visible;
}

export function findOutlineItem(items: readonly OutlineItem[], id: string): OutlineItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const nested = item.children ? findOutlineItem(item.children, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

export function flattenOutline(items: readonly OutlineItem[]): OutlineItem[] {
  const flat: OutlineItem[] = [];
  for (const item of items) {
    flat.push(item);
    if (item.children) flat.push(...flattenOutline(item.children));
  }
  return flat;
}
