/** Map shuffle assignment row → schedule worker video payload (includes videoId). */
export function toScheduleVideo(v: { title: string; url: string; videoId: string }) {
  if (v.url) {
    return { mode: 'url' as const, value: v.url, title: v.title, url: v.url, videoId: v.videoId };
  }
  return { mode: 'title' as const, value: v.title, title: v.title, videoId: v.videoId };
}
