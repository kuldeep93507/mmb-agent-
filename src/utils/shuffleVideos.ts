/** Map shuffle assignment row → schedule worker video payload (includes videoId). */
export function toScheduleVideo(v: {
  title: string;
  url: string;
  videoId: string;
  trafficSource?: string;
}) {
  const base = v.url
    ? { mode: 'url' as const, value: v.url, title: v.title, url: v.url, videoId: v.videoId }
    : { mode: 'title' as const, value: v.title, title: v.title, videoId: v.videoId };
  if (v.trafficSource) {
    return { ...base, trafficSource: v.trafficSource };
  }
  return base;
}
