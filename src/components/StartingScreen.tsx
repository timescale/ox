import { Loading } from './Loading';

export interface StartingScreenProps {
  step: string;
  /** Latest output line from the current build step */
  subDetail?: string;
  hint?: string;
}

export const StartingScreen = ({
  step,
  subDetail,
  hint,
}: StartingScreenProps) => (
  <Loading message="Loading" detail={step} subDetail={subDetail} hint={hint} />
);
