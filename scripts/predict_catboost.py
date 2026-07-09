#!/usr/bin/env python3
import argparse
import json
import sys

import pandas as pd
from catboost import CatBoostClassifier


def main():
    parser = argparse.ArgumentParser(description="Predict model-size recommendation with a trained CatBoost model.")
    parser.add_argument("--model", required=True, help="Path to trained .cbm model")
    parser.add_argument("--features-json", required=True, help="JSON array of feature dictionaries or single dict")
    args = parser.parse_args()

    model = CatBoostClassifier()
    model.load_model(args.model)

    data = json.loads(args.features_json)
    if isinstance(data, dict):
        data = [data]

    df = pd.DataFrame(data)
    required = list(model.feature_names_)
    missing = [c for c in required if c not in df.columns]
    if missing:
        print(f"Error: missing features {missing}", file=sys.stderr)
        sys.exit(1)

    probabilities = model.predict_proba(df[required])
    predictions = model.predict(df[required]).astype(int)

    out = []
    for pred, probs in zip(predictions, probabilities):
        out.append({
            "classIndex": int(pred),
            "probabilities": probs.tolist(),
            "confidence": round(float(probs[pred]), 4),
        })

    print(json.dumps(out if len(out) > 1 else out[0]))


if __name__ == "__main__":
    main()
