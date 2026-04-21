# Quantlab JSON Schemas

This directory contains JSON Schema definitions for Quantlab's core data structures.

## Schemas

| Schema | Description |
|--------|-------------|
| `order.schema.json` | Trading order structure |
| `position.schema.json` | Position tracking structure |
| `fill.schema.json` | Order fill/execution structure |
| `session_config.schema.json` | Trading session configuration |
| `golden_vector.schema.json` | Golden test vector format |

## Usage

### Python Validation

```python
import json
import jsonschema

# Load schema
with open('schemas/order.schema.json') as f:
    order_schema = json.load(f)

# Validate data
order_data = {
    "order_id": "abc123",
    "symbol": "AAPL",
    "side": "BUY",
    "quantity": 100,
    "order_type": "MARKET",
    "time_in_force": "GFD"
}

jsonschema.validate(order_data, order_schema)
```

### TypeScript Validation

```typescript
import Ajv from 'ajv';
import orderSchema from './schemas/order.schema.json';

const ajv = new Ajv();
const validate = ajv.compile(orderSchema);

const order = {
  order_id: 'abc123',
  symbol: 'AAPL',
  side: 'BUY',
  quantity: 100,
  order_type: 'MARKET',
  time_in_force: 'GFD'
};

if (validate(order)) {
  console.log('Valid order');
} else {
  console.log('Validation errors:', validate.errors);
}
```

## Schema Versioning

Schemas use JSON Schema 2020-12 draft. Breaking changes require a major version bump and migration guide.

## Adding New Schemas

1. Create schema file following naming convention: `<entity>.schema.json`
2. Include `$id` with full URL
3. Add to this README
4. Create corresponding TypeScript types if needed
