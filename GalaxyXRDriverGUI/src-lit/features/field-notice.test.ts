import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('row-owned notices', () => {
  it('renders a full-width notice stack with a divider inside the field card', () => {
    const base = read('./page-base.ts');
    expect(base).toContain('Auto-placement keeps the stack in row 2');
    expect(base).toContain('.field-notices {');
    expect(base).toContain('grid-column: 1 / -1;');
    expect(base).toContain('border-top: 1px solid var(--colorNeutralStroke2');
    expect(base).toContain('.field-notice--warning');
    expect(base).toContain('.field-notice--compact');
    expect(base).not.toContain('inert-note');
  });

  it('derives saved-but-not-applied notices from the row control key', () => {
    const base = read('./page-base.ts');
    expect(base).toContain('const noticeKey = opts?.noticeKey ?? opts?.settingId;');
    expect(base).toContain('inertReasons(spec, opts.ctx)');
    expect(base).toContain('compact: true');
    expect(base).toContain('notices.map(notice => fieldNotice(notice))');
  });

  it('moves identity and SDR10 notices into their own setting rows', () => {
    const page = read('./driver-settings-page.ts');
    expect(page).toContain('notices: nativeIdentityNotices');
    expect(page).toContain('notices: profileNotices');
    expect(page).toContain('notices: baselineNotices');
    expect(page).toContain('!advanced && (!gx.nativeIdentity || !gx.vrlinkHeadsetProfile)');
    expect(page).not.toContain("statusMessage('info', t('SDR 10-bit baseline is on')");
  });

  it('moves the row-specific stream notices and keeps gated notes in the card', () => {
    const page = read('./stream-frame-page.ts');
    expect(page).toContain('notices: tileWidthNotices');
    expect(page).toContain('notices: casNotices');
    expect(page).toContain('notices: [ofxrRuntimeNotice]');
    expect(page).toMatch(/settingFieldRow\('ofxr\.maxLogMb'[\s\S]{0,800}?ctx: controlContext/);
    expect(page).toContain("noticeKey: 'streamFrame.nvencSplitMode'");
    expect(page).toContain("noticeKey: 'streamFrame.kalmanGripBlend'");
    expect(page).toContain("noticeKey: 'streamFrame.deriveSmoothTauSlowMs'");
  });

  it('does not describe the retired controller layout as a Meta or PICO identity', () => {
    const page = read('./stream-frame-page.ts');
    const presentation = read('../domain/settings-presentation.ts');
    expect(page).not.toContain('Oculus Touch controller identity');
    expect(presentation).not.toContain('Simulate Oculus Touch');
    expect(presentation).toContain('Galaxy XR Headset Profile');
    expect(presentation).not.toContain('Mirror to Steam Link Aliases');
  });
});
