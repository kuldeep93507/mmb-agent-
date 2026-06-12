import { useCallback, useEffect, useState } from 'react';
import { fetchTrafficSourceStatus } from '../utils/trafficSourceControl';

/** Shared hook — engagement, fleet, shuffle, future agent pages. */
export function useDisabledTrafficSources() {
  const [disabledList, setDisabledList] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const s = await fetchTrafficSourceStatus();
      setDisabledList(s.disabled);
    } catch {
      setDisabledList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const disabled = new Set(disabledList);
  const isEnabled = useCallback(
    (id: string) => id === 'random' || !disabled.has(id),
    [disabledList],
  );

  return { disabled, disabledList, loading, isEnabled, reload };
}
