import Funnel from './components/Funnel';
import Ops from './components/Ops';

/**
 * Deliberately no router dependency. Two routes do not justify react-router,
 * and every dependency is one more thing to explain in the interview.
 *
 * The funnel variant is read from the path, mirroring how the reference
 * funnel is served at /qualification-v30. That is what makes A/B testing
 * possible without a deploy: point half the traffic at /qualification-v31
 * and the variant lands on every lead row and every Meta event.
 */
export default function App() {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');

  if (path === 'ops') return <Ops />;

  return <Funnel variant={path || 'qualification-v1'} />;
}
