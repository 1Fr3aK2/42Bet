// Privacy Policy, opened from the footer (#/privacy).
export default function PrivacyPolicy() {
  return (
    <article>
      <h1 id="legal-title" tabIndex={-1}>Privacy Policy</h1>
      <p className="legal-updated">Last updated: 29 October 2026</p>

      <p>
        Transcendence is a student project of the 42 Lisboa curriculum: a crypto price
        prediction game played with a virtual currency (T$), with a community forum. This
        policy explains which personal data the application collects, why, who can see it,
        how long it is kept and which rights you have under the EU General Data Protection
        Regulation (GDPR).
      </p>

      <h2>1. Who is responsible</h2>
      <p>
        The data controller is the Transcendence project team, a group of five students at
        42 Lisboa, Portugal. Requests about your data are handled by the project
        administrators (see section 9).
      </p>

      <h2>2. Data we collect</h2>
      <ul>
        <li>
          <strong>Account</strong>: username, email address, password, optional avatar
          image, role (user, moderator or administrator) and the dates the account was
          created and updated. The password is stored only as a bcrypt hash: nobody,
          including the team, can read it.
        </li>
        <li>
          <strong>Game</strong>: your virtual balance, your bets (coin, direction, amount,
          prices at the start and at the end, result, payout and dates) and your number of
          wins and losses.
        </li>
        <li>
          <strong>Forum</strong>: the posts and comments you write, the reports you send, and
          the moderation data linked to them (automatic moderation score and reasons,
          moderators&apos; decisions and notes, moderation history).
        </li>
        <li>
          <strong>Technical data</strong>: each request to the server is logged with your IP
          address, the date and time, the requested address, your browser identification
          (user agent) and the response code. Requests blocked by the web application
          firewall are logged with their content, which may include what you typed in a
          form. We also measure performance (number of requests, response times) in a way
          that does not identify you.
        </li>
        <li>
          <strong>Your browser</strong>: when you log in, your session token (valid for 24
          hours) and a copy of your basic profile are kept in your browser&apos;s local
          storage, so that you stay logged in after refreshing the page. They are removed
          when you log out. We use no cookies for tracking, statistics or advertising.
        </li>
      </ul>

      <h2>3. Why we use it</h2>
      <ul>
        <li>To create your account, log you in and show your profile, which is needed to provide the service you ask for.</li>
        <li>To run the game: keep your balance, record and settle your bets, and show your history.</li>
        <li>
          To run the forum and keep it safe: publish your posts and comments, check them with
          automatic moderation, which may hold a post until a moderator reviews it, and
          handle reports.
        </li>
        <li>To protect the service: detect and block attacks, investigate abuse and keep the application working, which is our legitimate interest in security.</li>
      </ul>
      <p>We do not sell your data, use it for advertising or build profiles of you.</p>

      <h2>4. Who can see it</h2>
      <ul>
        <li>
          <strong>Other users</strong> see your username and the posts and comments you
          publish. Your email address, balance and bets are not shown to them.
        </li>
        <li><strong>Moderators</strong> see reports and the moderation data of posts and comments.</li>
        <li>
          <strong>Administrators</strong> can see the list of accounts (username, email,
          role, avatar, balance, wins, losses and dates), change roles and remove content,
          in the application and through an administration API protected by a secret key.
        </li>
        <li>
          <strong>No third party</strong> receives your data. Live prices come from the public
          APIs of Kraken and CoinGecko: our server connects to them without sending any
          information about you.
        </li>
      </ul>

      <h2>5. How it is protected</h2>
      <p>
        The data is stored in a PostgreSQL database on the server that runs the application.
        Your browser only talks to the server over HTTPS. Passwords are hashed with bcrypt,
        the service credentials are kept in HashiCorp Vault, a web application firewall
        filters every request, and the logs and monitoring dashboards require a login.
      </p>

      <h2>6. How long we keep it</h2>
      <ul>
        <li>Account, game and forum data: as long as your account exists.</li>
        <li>Server and security logs: deleted automatically after 14 days. The daily archive copies of the logs are deleted after 30 days.</li>
        <li>Database backups: one copy per day, each deleted after 7 days.</li>
        <li>Session data in your browser: until you log out.</li>
      </ul>

      <h2>7. Your rights</h2>
      <p>
        Under the GDPR you can ask to access your data, correct it, delete it, restrict or
        object to its use, and receive a copy in a common format. You can change your
        username, avatar and password yourself in Settings. For anything else, contact us
        (section 9): we answer within one month. You can also complain to the Portuguese
        data protection authority, the Comissão Nacional de Proteção de Dados
        (<a href="https://www.cnpd.pt" target="_blank" rel="noreferrer">www.cnpd.pt</a>).
      </p>

      <h2>8. Age</h2>
      <p>Transcendence simulates betting, so it is meant only for people aged 18 or over.</p>

      <h2>9. Contact and changes</h2>
      <p>
        To exercise your rights or ask a question, contact the Transcendence team at
        42 Lisboa, Portugal; requests are handled by the project administrators. If this
        policy changes, the new version is published on this page with a new date. See
        also the <a href="#/terms">Terms of Service</a>.
      </p>
    </article>
  );
}
