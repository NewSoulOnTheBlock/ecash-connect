import { bodyTextStyles, titleTextStyles } from "../../styles";

export function SidePanelExplainer() {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "row-gap": "8px",
        "justify-content": "center",
        "align-items": "center",
      }}
    >
      <div
        style={{
          "font-size": "50px",
          "line-height": "140%",
        }}
      >
        🐈
      </div>
      <div style={titleTextStyles}>What is an eCash wallet?</div>
      <p style={bodyTextStyles}>
        It holds your ECX, the coin of the eCash fork of Bitcoin, and signs
        for you when an app asks, but only after you approve.
      </p>
      <p style={bodyTextStyles}>
        Connect one to use eCash apps and move ECX into sidechains.
      </p>
    </div>
  );
}
