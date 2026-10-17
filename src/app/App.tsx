import { SpikeScreen } from './SpikeScreen';
import { UpdatePrompt } from '../pwa/UpdatePrompt';

export function App() {
  return (
    <>
      <SpikeScreen />
      <UpdatePrompt />
      <div className="landscape-guard fixed inset-0 z-50 items-center justify-center bg-black text-center text-lg font-semibold">
        Rotate to portrait 📱
      </div>
    </>
  );
}
