export default function SettingsPage() {
  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <h1>설정</h1>
          <p>운영 설정</p>
        </div>
      </header>

      <section className="settingsLayout">
        <section className="settingsPanel">
          <div className="sectionHeader">
            <h2>운영 설정</h2>
          </div>
          <div className="emptyResult">아직 저장할 운영 설정이 없습니다.</div>
        </section>
      </section>
    </main>
  );
}
