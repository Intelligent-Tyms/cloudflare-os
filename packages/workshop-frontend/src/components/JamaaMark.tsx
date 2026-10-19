/** The Jamaa mark, inline so its stroke follows the surrounding text color in both themes. */
export default function JamaaMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-jamaa-mark
      className={className}
    >
      <path d="M4.5 10.5c1.6 4.8 4.2 7.2 7.5 7.2s5.9-2.4 7.5-7.2" stroke="currentColor" />
      <path d="M18.5 3.8l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" fill="#00e5ff" />
    </svg>
  )
}
