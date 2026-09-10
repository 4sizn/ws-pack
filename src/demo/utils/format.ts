/** 오전/오후 h:mm 형태의 카카오톡 스타일 시각 표기 */
export function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hour = d.getHours()
  const meridiem = hour < 12 ? '오전' : '오후'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const minute = String(d.getMinutes()).padStart(2, '0')
  return `${meridiem} ${h12}:${minute}`
}

/** 2026년 9월 10일 목요일 형태의 날짜 구분선 표기 */
export function formatDateDivider(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
}

/** 같은 날짜인지 비교한다. 날짜 구분선 삽입 위치를 정할 때 쓴다. */
export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}
