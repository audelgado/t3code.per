export function isChatNearEnd(scrollTop: number, clientHeight: number, scrollHeight: number) {
  return scrollHeight - clientHeight - scrollTop <= 96;
}
