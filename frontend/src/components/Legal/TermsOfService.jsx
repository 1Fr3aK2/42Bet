// Terms of Service, opened from the footer (#/terms).
export default function TermsOfService() {
  return (
    <article>
      <h1 id="legal-title" tabIndex={-1}>Terms of Service</h1>
      <p className="legal-updated">Last updated: 29 October 2026</p>

      <p>
        These terms apply to everyone who uses Transcendence. By creating an account or using
        the site, you accept them. If you do not agree, please do not use the service.
      </p>

      <h2>1. The service</h2>
      <p>
        Transcendence is a free student project of the 42 Lisboa curriculum. Players predict
        whether the price of Bitcoin or Ethereum will go up or down, using a virtual currency,
        and can take part in a community forum. It is provided for learning and demonstration
        only.
      </p>

      <h2>2. Who can use it</h2>
      <p>You must be at least 18 years old, because the game simulates betting. Each person may have only one account.</p>

      <h2>3. Your account</h2>
      <ul>
        <li>Give a valid email address and keep your password secret. You are responsible for what is done with your account.</li>
        <li>Tell an administrator if you think someone else has used your account.</li>
      </ul>

      <h2>4. Virtual currency and bets</h2>
      <ul>
        <li>
          T$ is a play currency with no monetary value. It cannot be bought, sold, exchanged,
          transferred or withdrawn, and nothing of real value can be won or lost.
        </li>
        <li>New accounts start with 1,000 T$.</li>
        <li>
          A bet predicts whether the price of BTC or ETH, in euros, will be higher (up) or lower
          (down) 60 seconds after the bet is placed. The stake is taken from your balance when
          you place the bet.
        </li>
        <li>
          The server records the live price from the Kraken exchange when the bet is placed and
          when it ends. If the price moved in the direction you chose, you receive your stake
          multiplied by 1.85 (your stake back plus 85%). If it moved the other way, you lose the
          stake. If it did not change, or if the server could not settle the bet on time, your
          stake is returned.
        </li>
        <li>Prices come from third parties and may be delayed or interrupted. The prices recorded by the server are final.</li>
        <li>We may correct balances or bets affected by a bug or by abuse, and reset the game.</li>
        <li>Nothing on Transcendence is financial or investment advice.</li>
      </ul>

      <h2>5. Forum rules</h2>
      <p>
        You keep the rights to what you post, and you allow Transcendence to display it in the
        service. You are responsible for your posts and comments. Do not publish:
      </p>
      <ul>
        <li>illegal content, harassment, threats, insults or hate speech;</li>
        <li>spam, advertising, scams or promises of guaranteed profit;</li>
        <li>other people&apos;s personal data, or content that pretends to come from someone else.</li>
      </ul>
      <p>
        Posts and comments are checked by automatic moderation and can be reported by any user.
        Moderators and administrators may hide or remove content that breaks these rules.
      </p>

      <h2>6. Acceptable use</h2>
      <p>
        Do not try to attack, overload or disrupt the service, to access other people&apos;s
        accounts or data, to get around its security measures or limits, or to use bugs to
        your advantage. If you find a bug, please report it to the team.
      </p>

      <h2>7. Suspension and deletion</h2>
      <p>
        Administrators may suspend or delete accounts that break these terms. You can stop using
        Transcendence at any time and ask for your account and data to be deleted, as explained
        in the <a href="#/privacy">Privacy Policy</a>.
      </p>

      <h2>8. Availability and liability</h2>
      <p>
        Transcendence is provided &quot;as is&quot;, without any guarantee that it will always be
        available or free of errors, or that data will never be lost. Since no real money is
        involved, and as far as the law allows, the team is not liable for any loss arising
        from its use.
      </p>

      <h2>9. Changes and applicable law</h2>
      <p>
        We may update these terms. The new version is published on this page with a new date,
        and continuing to use the service means you accept it. These terms are governed by
        Portuguese law, without affecting the rights you have as a consumer under EU law.
      </p>

      <h2>10. Contact</h2>
      <p>Questions about these terms can be sent to the Transcendence team at 42 Lisboa, Portugal.</p>
    </article>
  );
}
