import { formatTime } from '../utils/format';

// Countdown to the player's next result. There are no rounds: every bet lasts
// `duration` seconds from the moment it is placed, and the server settles it
// at the end. `secondsLeft` is null when the player has no bet running.
export default function Timer({ secondsLeft, duration }) {
  const running = secondsLeft !== null;
  const progress = running ? (secondsLeft / duration) * 100 : 0;

  return (
    <div className="timer-section">
      <div className="timer-top">
        <span className="timer-label">{running ? 'Next result in' : 'Each bet lasts'}</span>
        <span className="timer-countdown">{formatTime(running ? secondsLeft : duration)}</span>
      </div>
      <div className="timer-bar-wrapper">
        <div
          className="timer-bar"
          style={{ width: `${progress}%`, background: '#e8a020' }}
        />
      </div>
    </div>
  );
}
