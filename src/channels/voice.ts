import type { File as TgFile } from "grammy/types";

export async function downloadVoice(file: TgFile, botToken: string): Promise<Buffer> {
  const filePath = file.file_path;
  if (!filePath) throw new Error("No file_path in Telegram file object");

  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download voice: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
