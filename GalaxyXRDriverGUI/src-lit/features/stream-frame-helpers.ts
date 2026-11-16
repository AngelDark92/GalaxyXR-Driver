import { t } from '../locale/i18n';
import type { FieldNotice } from '../ui/presentation';

/** Label and row-owned notices for the bandwidth row. Force CBR changes the
 *  label and adds a notice that the saved curve, constancy and headroom are
 *  preserved but not applied. */
export function bandwidthRowState(forceCbr: boolean): { label: string; notices: FieldNotice[] } {
  const label = forceCbr ? t('Average Bitrate (Mbit/s)') : t('Max Bitrate (Mbit/s)');
  const notices: FieldNotice[] = forceCbr
    ? [{
        intent: 'info',
        title: t('Force CBR is on'),
        body: t('The bitrate curve, constancy and headroom are saved but not applied. The encoder average and maximum both equal this budget.'),
        compact: true,
      }]
    : [];
  return { label, notices };
}
