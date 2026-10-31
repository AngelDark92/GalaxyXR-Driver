import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { driverDefaults } from './driver-defaults';
import { ROUTES, type Route } from './navigation';
import {
  CHAPTER_OUTLINES, findOutlineItem, flattenOutline, visibleOutline, type OutlineContext,
} from './page-outline';

const settings = () => structuredClone(driverDefaults.streamFrame!);

const ctx = (overrides: Partial<OutlineContext> = {}): OutlineContext => ({
  vendor: false,
  advancedMode: false,
  enhancements: false,
  controllerBypass: false,
  kalmanMode: false,
  gameLinkLayout: false,
  hasControllerSettings: false,
  settings: settings(),
  ...overrides,
});

const PAGE_FILES: Record<Route, string> = {
  'driver-settings': 'driver-settings-page.ts',
  'stream-frame': 'stream-frame-page.ts',
  debug: 'debug-page.ts',
  'distortion-profile': 'distortion-profile-page.ts',
  'app-settings': 'app-settings-page.ts',
  setup: 'setup-page.ts',
  about: 'about-page.ts',
};

function pageSource(route: Route): ts.SourceFile {
  const file = PAGE_FILES[route];
  const source = readFileSync(new URL(`../features/${file}`, import.meta.url), 'utf8');
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function stringArg(call: ts.CallExpression, index: number): string | undefined {
  const arg = call.arguments[index];
  return arg && ts.isStringLiteral(arg) ? arg.text : undefined;
}

function numberArg(call: ts.CallExpression, index: number): number | undefined {
  const arg = call.arguments[index];
  return arg && ts.isNumericLiteral(arg) ? Number(arg.text) : undefined;
}

function walkCalls(source: ts.SourceFile, visit: (name: string, call: ts.CallExpression) => void): void {
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) visit(node.expression.text, node);
    ts.forEachChild(node, walk);
  };
  walk(source);
}

function pageAnchors(route: Route): Set<string> {
  const source = pageSource(route);
  const anchors = new Set<string>();
  walkCalls(source, (name, call) => {
    const anchor = name === 'sectionHeading' ? stringArg(call, 2)
      : name === 'sectionRow' ? stringArg(call, 4)
        : name === 'sectionGroup' ? stringArg(call, 3)
          : undefined;
    if (anchor) anchors.add(anchor);
  });
  return anchors;
}

describe('chapter table of contents', () => {
  it('covers every route with unique anchors', () => {
    for (const route of ROUTES) {
      const ids = flattenOutline(CHAPTER_OUTLINES[route]).map(item => item.id);
      expect(new Set(ids).size, route).toBe(ids.length);
      expect(ids.length, route).toBeGreaterThan(0);
    }
  });

  it('nests Advanced under Optical Flow only while Advanced Mode is on', () => {
    const base = ctx({ vendor: true });
    const closed = visibleOutline(CHAPTER_OUTLINES['stream-frame'], base);
    const opticalFlow = closed.find(item => item.id === 'optical-flow')!;
    expect(opticalFlow.children).toBeUndefined();

    const open = visibleOutline(CHAPTER_OUTLINES['stream-frame'], ctx({ vendor: true, advancedMode: true }));
    const withAdvanced = open.find(item => item.id === 'optical-flow')!;
    expect(withAdvanced.children?.map(item => item.id)).toEqual(['advanced']);
    expect(withAdvanced.children?.[0].open).toEqual(['heading:optical-flow']);
  });

  it('nests Color and Image Enhancements under Image Processing', () => {
    const off = visibleOutline(CHAPTER_OUTLINES['stream-frame'], ctx());
    const imageOff = off.find(item => item.id === 'image-processing')!;
    expect(imageOff.children).toBeUndefined();

    const on = visibleOutline(CHAPTER_OUTLINES['stream-frame'], ctx({ enhancements: true }));
    const imageOn = on.find(item => item.id === 'image-processing')!;
    expect(imageOn.children?.map(item => item.id)).toEqual(['color', 'image-enhancements']);
    expect(imageOn.children?.every(item => item.open?.[0] === 'heading:image-processing')).toBe(true);
  });

  it('builds the controller group tree and respects the controller bypass', () => {
    const on = visibleOutline(CHAPTER_OUTLINES['driver-settings'], ctx({
      vendor: true, advancedMode: true, kalmanMode: true,
      gameLinkLayout: true, hasControllerSettings: true,
    }));
    const controllers = on.find(item => item.id === 'controllers')!;
    expect(controllers.children?.map(item => item.id))
      .toEqual(['controller-fix', 'game-link-layout', 'controllers-advanced']);

    const fix = controllers.children!.find(item => item.id === 'controller-fix')!;
    expect(fix.children?.map(item => item.id)).toEqual(['kalman-advanced']);
    const gameLink = controllers.children!.find(item => item.id === 'game-link-layout')!;
    expect(gameLink.children?.map(item => item.id)).toEqual(['game-link-offsets']);
    const advanced = controllers.children!.find(item => item.id === 'controllers-advanced')!;
    expect(advanced.children?.map(item => item.id)).toEqual(['controller-offsets', 'pointer-tip-offset']);
    expect(flattenOutline(controllers.children ?? []).every(item => item.open?.[0] === 'controllers')).toBe(true);

    const bypassed = visibleOutline(CHAPTER_OUTLINES['driver-settings'], ctx({
      vendor: true, advancedMode: true, controllerBypass: true,
    }));
    expect(bypassed.find(item => item.id === 'controllers')?.children).toBeUndefined();
  });

  it('keeps the advanced Eye Alignment group and the app Update install group nested', () => {
    const distortion = visibleOutline(CHAPTER_OUTLINES['distortion-profile'],
      ctx({ enhancements: true, advancedMode: true }));
    expect(distortion.find(item => item.id === 'distortion')?.children?.map(item => item.id))
      .toEqual(['eye-align']);

    const app = visibleOutline(CHAPTER_OUTLINES['app-settings'], ctx());
    expect(app.find(item => item.id === 'app-advanced')?.children?.map(item => item.id))
      .toEqual(['app-update-install']);
  });

  it('finds nested items and flattens in page order', () => {
    const outline = visibleOutline(CHAPTER_OUTLINES['driver-settings'], ctx({
      vendor: true, advancedMode: true, kalmanMode: true, hasControllerSettings: true,
    }));
    expect(findOutlineItem(outline, 'kalman-advanced')?.label).toBe('Kalman Advanced Settings');
    expect(findOutlineItem(outline, 'missing')).toBeUndefined();
    const ids = flattenOutline(outline).map(item => item.id);
    expect(ids.indexOf('controllers')).toBeLessThan(ids.indexOf('controller-fix'));
    expect(ids.indexOf('controller-fix')).toBeLessThan(ids.indexOf('kalman-advanced'));
  });

  it('backs every catalog anchor with a section id in the page source', () => {
    for (const route of ROUTES) {
      const anchors = pageAnchors(route);
      for (const item of flattenOutline(CHAPTER_OUTLINES[route])) {
        expect(anchors.has(item.id), `${route}: section-${item.id}`).toBe(true);
      }
    }
  });

  it('never passes a nested depth to sectionRow or sectionHeading', () => {
    // Only depth-0 sections may collapse. Nested sections are groups created
    // with sectionGroup(); this ratchet keeps a collapsible card from nesting
    // inside another collapsible card.
    for (const route of ROUTES) {
      const source = pageSource(route);
      walkCalls(source, (name, call) => {
        const level = name === 'sectionHeading' ? numberArg(call, 1)
          : name === 'sectionRow' ? numberArg(call, 2)
            : undefined;
        if (level !== undefined && level >= 1) {
          const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
          throw new Error(`${PAGE_FILES[route]}:${line}: ${name} level ${level} must be a sectionGroup`);
        }
      });
    }
  });
});
