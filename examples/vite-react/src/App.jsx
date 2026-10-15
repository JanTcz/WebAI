const trails = [
  { name: 'Ridge Loop', km: 12, level: 'moderate' },
  { name: 'Lake Path', km: 5, level: 'easy' },
  { name: 'Summit Push', km: 18, level: 'hard' },
];

export default function App() {
  return (
    <main className="page">
      <h1>Trail Notes</h1>
      <p className="lead">Weekend hikes within an hour of the city.</p>
      <ul className="trails">
        {trails.map((t) => (
          <li key={t.name} className="trail">
            <h2>{t.name}</h2>
            <p>
              {t.km} km · {t.level}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
