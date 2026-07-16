#!/usr/bin/env python3
"""Train a simple MLP classifier with torch.

Exports weights as JSON so the TS-side TorchModel can run prediction purely
in TypeScript (no cross-process overhead at inference time).

Architecture: input(n_features) → hidden(64) → ReLU → output(3) → softmax
"""
import argparse
import json
import sys

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from sklearn.preprocessing import StandardScaler

HIDDEN_SIZE = 64
NUM_CLASSES = 3
EPOCHS = 300
LEARNING_RATE = 0.01


def main():
    parser = argparse.ArgumentParser(description="Train an MLP with torch, export TS-compatible JSON.")
    parser.add_argument('--train-csv', required=True, help='Path to training CSV')
    parser.add_argument('--model-out', required=True, help='Output path for model JSON')
    args = parser.parse_args()

    df = pd.read_csv(args.train_csv)
    if 'label' not in df.columns:
        print("Error: CSV must contain a 'label' column", file=sys.stderr)
        sys.exit(1)

    feature_cols = [c for c in df.columns if c != 'label']
    X = df[feature_cols].values.astype(np.float32)
    y = df['label'].astype(int).values

    # Standardize features
    scaler = StandardScaler()
    X_norm = scaler.fit_transform(X).astype(np.float32)

    X_tensor = torch.from_numpy(X_norm)
    y_tensor = torch.from_numpy(y).long()

    num_features = len(feature_cols)
    model = nn.Sequential(
        nn.Linear(num_features, HIDDEN_SIZE),
        nn.ReLU(),
        nn.Linear(HIDDEN_SIZE, NUM_CLASSES),
    )

    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=LEARNING_RATE)

    model.train()
    for epoch in range(EPOCHS):
        optimizer.zero_grad()
        logits = model(X_tensor)
        loss = criterion(logits, y_tensor)
        loss.backward()
        optimizer.step()

    # Evaluate training accuracy
    model.eval()
    with torch.no_grad():
        preds = model(X_tensor).argmax(dim=1).numpy()
        accuracy = float(np.mean(preds == y))

    # Export weights in TS-compatible format
    W1 = model[0].weight.detach().numpy()  # [hidden, features]
    b1 = model[0].bias.detach().numpy()    # [hidden]
    W2 = model[2].weight.detach().numpy()  # [classes, hidden]
    b2 = model[2].bias.detach().numpy()    # [classes]

    # Transpose W1/W2 so TS can do: h = relu(x @ W1 + b1) where W1 is [features, hidden]
    data = {
        'W1': W1.T.tolist(),  # [features, hidden]
        'b1': b1.tolist(),    # [hidden]
        'W2': W2.T.tolist(),  # [hidden, classes]
        'b2': b2.tolist(),    # [classes]
        'featureMeans': scaler.mean_.tolist(),
        'featureStds': scaler.scale_.tolist(),
        'hiddenSize': HIDDEN_SIZE,
        'epochs': EPOCHS,
    }
    with open(args.model_out, 'w') as f:
        json.dump(data, f)

    # Feature importance: mean abs weight of first layer
    importance = {}
    for f, col in enumerate(feature_cols):
        importance[col] = float(np.mean(np.abs(W1[:, f])))

    print(json.dumps({
        'modelOut': args.model_out,
        'accuracy': accuracy,
        'featureImportance': importance,
        'trainSamples': len(df),
    }))


if __name__ == '__main__':
    main()
