import styles from './navigation.module.css';

export function BackIcon() {
  return <svg class={`${styles.scope} ui-icon`} viewBox="0 0 20 20" aria-hidden="true"><path d="m11.8 4.7-5.3 5.3 5.3 5.3M6.8 10h7" /></svg>;
}

export function PlusIcon() {
  return <svg class={`${styles.scope} ui-icon`} viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>;
}
