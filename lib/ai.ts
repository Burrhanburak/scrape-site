
// lib/ai.ts
import OpenAI from 'openai';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai'; // Gerekli importları ekle

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Initialize Gemini GoogleGenerativeAI instance
const geminiParentInstance = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
export { geminiParentInstance }; // Doğrudan GoogleGenerativeAI instance'ını export et

// İsteğe bağlı olarak, güvenlik ayarlarını burada tanımlayabilirsin
// Bu ayarları model.generateContent çağrısında da belirtebilirsin
export const defaultSafetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
];