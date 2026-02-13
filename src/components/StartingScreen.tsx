import { Loading } from './Loading';

export interface StartingScreenProps {
  step: string;
  hint?: string;
}

export const StartingScreen = ({ step, hint }: StartingScreenProps) => (
  <Loading message="Loading" detail={step} hint={hint} />
);
