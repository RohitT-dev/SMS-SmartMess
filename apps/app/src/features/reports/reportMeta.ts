import { useAuthStore } from '../../state/authStore';
import { DEFAULT_MESS_NAME } from './reportDocument';

/** Who is generating the report and for which mess - read when the document is built. */
export function reportContext(): { messName: string; generatedBy?: string } {
  const email = useAuthStore.getState().session?.user?.email;
  return { messName: DEFAULT_MESS_NAME, generatedBy: email || undefined };
}
