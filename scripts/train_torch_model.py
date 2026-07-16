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
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import StandardScaler

HIDDEN_SIZE = 64
NUM_CLASSES = 3
EPOCHS = 300
LEARNING_RATE = 0.01
CV_FOLDS = 5


def make_model(num_features):
    return nn.Sequential(
        nn.Linear(num_features, HIDDEN_SIZE),
        nn.ReLU(),
        nn.Linear(HIDDEN_SIZE, NUM_CLASSES),
    )


def train_one_fold(X_train, y_train, num_features, seed=42):
    """Train a fresh MLP on the given fold, return the model."""
    torch.manual_seed(seed)
    model = make_model(num_features)
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=LEARNING_RATE)

    X_tensor = torch.from_numpy(X_train)
    y_tensor = torch.from_numpy(y_train).long()

    model.train()
    for _ in range(EPOCHS):
        optimizer.zero_grad()
        logits = model(X_tensor)
        loss = criterion(logits, y_tensor)
        loss.backward()
        optimizer.step()
    return model


def _safe_cv(X, y, folds):
    """Stratified K-fold CV for the MLP. Returns (cv_acc, n_folds) or (None, 0)."""
    n = len(y)
    n_classes = len(np.unique(y))
    max_folds = max(2, n // max(1, n_classes))
    k = min(folds, max_folds)
    if k < 2 or n < 4:
        return None, 0
    try:
        skf = StratifiedKFold(n_splits=k, shuffle=True, random_state=42)
        accs = []
        for tr_idx, va_idx in skf.split(X, y):
            X_tr_raw = X[tr_idx]
            X_va_raw = X[va_idx]
            # StandardScaler 必须只在训练折 fit,避免泄露
            scaler = StandardScaler()
            X_tr = scaler.fit_transform(X_tr_raw).astype(np.float32)
            X_va = scaler.transform(X_va_raw).astype(np.float32)
            y_tr = y[tr_idx]

            num_features = X.shape[1]
            model = train_one_fold(X_tr, y_tr, num_features)
            model.eval()
            with torch.no_grad():
                preds = model(torch.from_numpy(X_va)).argmax(dim=1).numpy()
            accs.append(float(np.mean(preds == y[va_idx])))
        return float(np.mean(accs)), k
    except Exception:
        return None, 0


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

    # Standardize features (full data, for the final exported model)
    scaler = StandardScaler()
    X_norm = scaler.fit_transform(X).astype(np.float32)

    num_features = len(feature_cols)
    model = train_one_fold(X_norm, y, num_features, seed=42)

    # Evaluate training accuracy
    model.eval()
    with torch.no_grad():
        preds = model(torch.from_numpy(X_norm)).argmax(dim=1).numpy()
        accuracy = float(np.mean(preds == y))

    # K-fold CV — 报告泛化能力,StandardScaler 严格只在折内 fit
    cv_acc, cv_k = _safe_cv(X, y, CV_FOLDS)

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
        'cvAccuracy': cv_acc,
        'cvFolds': cv_k,
        'featureImportance': importance,
        'trainSamples': len(df),
    }))


if __name__ == '__main__':
    main()
