import { model, Schema, type Types } from 'mongoose';

export interface ProductRecord {
  _id: Types.ObjectId;
  name: string;
  description: string;
  price: number;
  imageUrl: string;
  category: string;
  countInStock: number;
  rating: number;
  /** Number of reviews. */
  reviews: number;
  /** Admin who created the product. */
  user: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<ProductRecord>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, required: true },
    price: { type: Number, required: true, min: 0, default: 0 },
    imageUrl: { type: String, required: true },
    category: { type: String, required: true },
    countInStock: { type: Number, required: true, min: 0, default: 0 },
    rating: { type: Number, required: true, min: 0, max: 5, default: 0 },
    reviews: { type: Number, required: true, min: 0, default: 0 },
    user: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  },
  { timestamps: true },
);

// The shop lists newest-first or by price, with or without a category. Each index serves both the
// filter and the sort, so the database reads one page instead of every product. (Keyword search
// matches text anywhere in a word, which no index can serve; see the ponytail note in
// products.service.ts.)
productSchema.index({ createdAt: -1 });
productSchema.index({ price: 1 });
productSchema.index({ category: 1, createdAt: -1 });
productSchema.index({ category: 1, price: 1 });

export const Product = model<ProductRecord>('Product', productSchema);
