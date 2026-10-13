// 浏览器 TTS 封装（听音题与单词朗读共用）
export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function speak(text: string, rate = 0.9): boolean {
  if (!canSpeak() || !text) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = rate;
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function stopSpeak(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}
